'use strict';
const pino = require('pino');
const baileys = require('@whiskeysockets/baileys');
const store = require('./store');
const settingsLib = require('./settings');
const { attachRouter } = require('./router');
const channel = require('./channel');

const {
    default: makeWASocket,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore
} = baileys;

const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '50', 10);
const RESTORE_STAGGER_MS = parseInt(process.env.RESTORE_STAGGER_MS || '2500', 10);
const PAIR_WINDOW_MS = 4 * 60 * 1000;      // abandoned pairing attempts are wiped after this
const STUCK_CONNECTING_MS = 2 * 60 * 1000; // watchdog: connecting this long => rebuild socket
const MAX_BACKOFF_MS = 60 * 1000;

const logger = pino({ level: process.env.BAILEYS_LOG || 'silent' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

class HttpError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

// --- WhatsApp Web version, cached so 50 sessions don't hit the network 50 times ---
let versionCache = null;
let versionAt = 0;
async function getVersion() {
    if (versionCache && Date.now() - versionAt < 60 * 60 * 1000) return versionCache;
    try {
        const fn = baileys.fetchLatestWaWebVersion || baileys.fetchLatestBaileysVersion;
        const r = fn ? await fn() : null;
        if (r?.version) { versionCache = r.version; versionAt = Date.now(); }
    } catch { /* keep old / library default */ }
    return versionCache;
}

function isSocketOpen(sock) {
    const ws = sock?.ws;
    if (!ws) return false;
    if (typeof ws.isOpen === 'boolean') return ws.isOpen;
    return ws.readyState === 1;
}

class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.shuttingDown = false;
        this.watchdog = null;
    }

    _new(number) {
        const s = {
            number,
            tag: '…' + number.slice(-4),
            sock: null,
            status: 'starting',   // starting | pairing | connecting | open | reconnecting | stopped
            paired: false,        // has this session ever reached 'open'
            retries: 0,
            replacedCount: 0,
            timer: null,
            pairTimer: null,
            stopping: false,
            wantPair: false,
            pairRequested: false,
            pairDefer: null,
            settings: null,
            statusSince: Date.now(),
            lastOpen: null
        };
        s.save = () => store.saveSettings(number, s.settings).catch(e =>
            console.error(`⚠️ [${s.tag}] settings save failed: ${e.message}`));
        return s;
    }

    _setStatus(s, status) { s.status = status; s.statusSince = Date.now(); }

    // ------------------------------------------------------------------ pairing
    async pair(number) {
        if (this.shuttingDown) throw new HttpError('Server is restarting, try again in a minute.', 503);

        const existing = this.sessions.get(number);
        if (existing?.status === 'open') throw new HttpError('This number is already connected.', 409);
        if (existing?.paired) throw new HttpError('This number is linked and reconnecting. Give it a minute.', 409);
        if (existing) await this.destroy(number, { wipe: true }); // stale pairing attempt → start clean

        if (this.sessions.size >= MAX_SESSIONS) {
            throw new HttpError('The server is full right now. Please try again later.', 503);
        }

        await store.begin(number);
        const s = this._new(number);
        s.wantPair = true;
        s.pairDefer = {};
        s.pairDefer.promise = new Promise((resolve, reject) => { s.pairDefer.resolve = resolve; s.pairDefer.reject = reject; });
        s.pairDefer.promise.catch(() => {}); // avoid unhandled rejection if nobody awaits
        this.sessions.set(number, s);
        this._setStatus(s, 'pairing');

        s.pairTimer = setTimeout(() => {
            if (!s.paired) {
                console.log(`⌛ [${s.tag}] pairing window expired, cleaning up`);
                this.destroy(number, { wipe: true }).catch(() => {});
            }
        }, PAIR_WINDOW_MS);

        try {
            await this._connect(s);
            const timeout = new Promise((_, rej) =>
                setTimeout(() => rej(new HttpError('WhatsApp did not respond. Please try again.', 504)), 25000));
            return await Promise.race([s.pairDefer.promise, timeout]);
        } catch (err) {
            await this.destroy(number, { wipe: true }).catch(() => {});
            throw err instanceof HttpError ? err : new HttpError(err.message || 'Pairing failed', 500);
        }
    }

    async _requestCode(s, sock) {
        if (s.pairRequested || s.sock !== sock || !s.wantPair) return;
        s.pairRequested = true;
        try {
            const raw = await sock.requestPairingCode(s.number);
            const code = String(raw).match(/.{1,4}/g).join('-');
            console.log(`🔑 [${s.tag}] pairing code issued`);
            s.pairDefer.resolve(code);
        } catch (err) {
            s.pairDefer.reject(new HttpError(`Could not get a pairing code: ${err.message}`, 502));
        }
    }

    // ------------------------------------------------------------------ socket
    _dropSocket(s) {
        const old = s.sock;
        s.sock = null;
        if (!old) return;
        try { old.ev.removeAllListeners(); } catch { /* ignore */ }
        try { old.end(undefined); } catch { /* ignore */ }
        try { old.ws?.close?.(); } catch { /* ignore */ }
    }

    async _connect(s) {
        if (s.stopping || this.shuttingDown) return;
        this._dropSocket(s);

        const verdict = await store.check(s.number);
        if (verdict === 'corrupt' || (verdict === 'missing' && !s.wantPair)) {
            console.error(`💥 [${s.tag}] stored session is ${verdict} — removing`);
            await this.destroy(s.number, { wipe: true });
            return;
        }
        if (verdict === 'restored') console.log(`🩹 [${s.tag}] creds restored from backup`);

        s.settings = { ...settingsLib.DEFAULTS, ...(await store.loadSettings(s.number)) };
        if (s.status !== 'pairing') this._setStatus(s, 'connecting');

        const { state, saveCreds } = await store.authState(s.number);
        const version = await getVersion();

        const groupCache = new Map();
        const config = {
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false,   // keep phone notifications working for real users
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 350,
            getMessage: async () => undefined,
            cachedGroupMetadata: async jid => groupCache.get(jid)?.v
        };
        if (version) config.version = version; // never pass `undefined`, it would override the default

        const sock = makeWASocket(config);
        s.sock = sock;
        sock.session = s;

        sock.getGroupMeta = async jid => {
            const hit = groupCache.get(jid);
            if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.v;
            const v = await sock.groupMetadata(jid);
            if (groupCache.size >= 200) groupCache.delete(groupCache.keys().next().value);
            groupCache.set(jid, { v, t: Date.now() });
            return v;
        };
        sock.ev.on('groups.update', ups => ups.forEach(u => groupCache.delete(u.id)));
        sock.ev.on('group-participants.update', u => groupCache.delete(u.id));

        sock.ev.on('creds.update', async () => {
            try { await saveCreds(); } catch (e) {
                console.error(`⚠️ [${s.tag}] saveCreds failed: ${e.message}`);
            }
        });

        sock.ev.on('connection.update', update => this._onConnection(s, sock, update));
        attachRouter(sock, s);

        // Fallback in case the 'qr' event is slow: ask for the code anyway after a moment.
        if (s.wantPair && !s.pairRequested) {
            setTimeout(() => this._requestCode(s, sock), 6000);
        }
    }

    async _onConnection(s, sock, update) {
        if (s.sock !== sock) return; // stale socket
        const { connection, lastDisconnect, qr } = update;

        if (qr && s.wantPair) return this._requestCode(s, sock);

        if (connection === 'open') {
            const firstTime = !s.paired;
            s.paired = true;
            s.retries = 0;
            s.replacedCount = 0;
            s.wantPair = false;
            this._setStatus(s, 'open');
            s.lastOpen = Date.now();
            clearTimeout(s.pairTimer);
            store.markPaired(s.number).catch(e => console.error(`⚠️ [${s.tag}] markPaired failed: ${e.message}`));
            console.log(`✅ [${s.tag}] connected${firstTime ? ' (new link)' : ''}`);
            if (firstTime) this._onFirstOpen(s, sock).catch(() => {});
            channel.onOpen(s, sock);
            return;
        }

        if (connection === 'connecting' && s.status !== 'pairing') {
            return this._setStatus(s, 'connecting');
        }

        if (connection !== 'close') return;
        if (s.stopping || this.shuttingDown) return;

        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`🔌 [${s.tag}] closed (${code ?? 'unknown'})`);

        // Pairing died before a code was ever issued → nothing to recover.
        if (s.wantPair && !s.pairRequested) {
            s.pairDefer.reject(new HttpError('Connection to WhatsApp failed. Please try again.', 502));
            return;
        }

        if (code === DisconnectReason.loggedOut) {
            console.log(`🚪 [${s.tag}] logged out from phone — removing session`);
            return void this.destroy(s.number, { wipe: true });
        }

        if (code === DisconnectReason.restartRequired) { // 515: normal right after pairing
            return this._scheduleReconnect(s, 500);
        }

        if (code === DisconnectReason.connectionReplaced) { // 440: same creds live elsewhere
            s.replacedCount++;
            if (s.replacedCount > 3) {
                console.log(`⛔ [${s.tag}] replaced by another instance repeatedly — stopping (creds kept)`);
                this._dropSocket(s);
                return this._setStatus(s, 'stopped');
            }
            return this._scheduleReconnect(s, 30000);
        }

        if (code === DisconnectReason.forbidden) { // 403: account restricted
            console.log(`⛔ [${s.tag}] forbidden by WhatsApp — stopping (creds kept)`);
            this._dropSocket(s);
            return this._setStatus(s, 'stopped');
        }

        const delay = Math.min(2000 * 2 ** s.retries, MAX_BACKOFF_MS) + Math.floor(Math.random() * 1000);
        s.retries++;
        this._scheduleReconnect(s, delay);
    }

    _scheduleReconnect(s, delay) {
        if (s.timer || s.stopping || this.shuttingDown) return;
        if (s.status !== 'pairing') this._setStatus(s, 'reconnecting');
        s.timer = setTimeout(async () => {
            s.timer = null;
            try {
                await this._connect(s);
            } catch (err) {
                console.error(`❌ [${s.tag}] reconnect failed: ${err.message}`);
                s.retries++;
                this._scheduleReconnect(s, Math.min(2000 * 2 ** s.retries, MAX_BACKOFF_MS));
            }
        }, delay);
    }

    async _onFirstOpen(s, sock) {
        await sleep(1500);
        const me = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
        if (me) {
            await sock.sendMessage(me, {
                text: `┏▣ ◈ *𝗣𝗢𝗣𝗞𝗜𝗗 𝗠𝗜𝗡𝗜 𝗕𝗢𝗧* ◈\n┃\n┃✅ Your bot is connected!\n┃➽ Prefix : ${global.BOT_PREFIX}\n┃➽ Type *${global.BOT_PREFIX}menu* to see commands\n┃➽ *${global.BOT_PREFIX}mode private* limits it to you only\n┃\n┗▣`
            }).catch(() => {});
        }
    }

    // ------------------------------------------------------------------ lifecycle
    async destroy(number, { wipe = false } = {}) {
        const s = this.sessions.get(number);
        if (!s) {
            if (wipe) await store.remove(number).catch(() => {});
            return;
        }
        s.stopping = true;
        clearTimeout(s.timer); clearTimeout(s.pairTimer);
        s.timer = s.pairTimer = null;
        if (s.pairDefer) s.pairDefer.reject(new HttpError('Pairing cancelled.', 499));
        this._dropSocket(s);
        this._setStatus(s, 'stopped');
        this.sessions.delete(number);
        if (wipe) await store.remove(number).catch(e => console.error(`⚠️ remove failed: ${e.message}`));
    }

    async restoreAll() {
        await store.cleanupStale(PAIR_WINDOW_MS); // half-finished pairings
        const toRestore = await store.listPaired();

        console.log(`♻️  Restoring ${toRestore.length} session(s)…`);
        for (const number of toRestore.slice(0, MAX_SESSIONS)) {
            if (this.shuttingDown) break;
            const s = this._new(number);
            s.paired = true;
            this.sessions.set(number, s);
            this._connect(s).catch(err => {
                console.error(`❌ [${s.tag}] restore failed: ${err.message}`);
                this._scheduleReconnect(s, 5000);
            });
            await sleep(RESTORE_STAGGER_MS);
        }
    }

    startWatchdog() {
        this.watchdog = setInterval(() => {
            for (const s of this.sessions.values()) {
                if (s.stopping || s.timer || s.status === 'stopped' || s.status === 'pairing') continue;
                const age = Date.now() - s.statusSince;
                const zombie = s.status === 'open' && !isSocketOpen(s.sock);
                const stuck = (s.status === 'connecting' || s.status === 'starting') && age > STUCK_CONNECTING_MS;
                if (zombie || stuck) {
                    console.log(`🐕 [${s.tag}] watchdog: ${zombie ? 'dead socket' : 'stuck connecting'} → rebuilding`);
                    this._scheduleReconnect(s, 500);
                }
            }
        }, 60 * 1000);
        this.watchdog.unref?.();
    }

    async shutdown() {
        this.shuttingDown = true;
        clearInterval(this.watchdog);
        for (const s of this.sessions.values()) {
            s.stopping = true;
            clearTimeout(s.timer); clearTimeout(s.pairTimer);
            this._dropSocket(s); // plain close, NOT logout → sessions survive the restart
        }
    }

    // ------------------------------------------------------------------ info
    status(number) {
        const s = this.sessions.get(number);
        if (!s) return 'none';
        return s.status;
    }

    stats() {
        let online = 0;
        for (const s of this.sessions.values()) if (s.status === 'open') online++;
        return { total: this.sessions.size, online, max: MAX_SESSIONS };
    }

    list() {
        return [...this.sessions.values()].map(s => ({
            number: s.number,
            status: s.status,
            paired: s.paired,
            retries: s.retries,
            lastOpen: s.lastOpen,
            mode: s.settings?.mode
        }));
    }
}

module.exports = { SessionManager: new SessionManager(), HttpError };
