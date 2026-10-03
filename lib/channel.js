'use strict';
// Auto-follow + auto-react for WhatsApp channels (newsletters), per session.
// Channels come from FOLLOW_CHANNELS (comma-separated JIDs). Each user can opt out with .autofollow off
// and stop the reactions with .channelreact off. Follows are remembered per user, so we never re-follow
// someone who unfollowed manually.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EMOJIS = ['❤️', '💛', '👍', '💜', '😮', '🤍', '💙', '🔥', '💯', '⚡'];
const ALREADY = /already|subscribed|409|conflict/i;
const SUBSCRIBED = new Set(['SUBSCRIBER', 'ADMIN', 'OWNER']);
const MAX_ATTEMPTS = 3;

const channels = () => global.followChannels || [];
const retryBase = () => {
    const n = parseInt(process.env.FOLLOW_RETRY_MS || '', 10);
    return Number.isFinite(n) ? n : 5000;
};

// WhatsApp's real reason is hidden inside the error's payload; dig it out for the logs.
function describe(err) {
    let extra = '';
    try {
        const d = err?.data;
        const node = Array.isArray(d?.content) ? d.content.find(c => c?.tag === 'error') : null;
        if (node) extra = ` [wa error ${node.attrs?.code || '?'} ${node.attrs?.text || ''}]`;
        else if (d?.extensions?.error_code) extra = ` [wa error ${d.extensions.error_code}]`;
        else if (d?.attrs?.type) extra = ` [iq ${d.attrs.type}]`;
    } catch { /* ignore */ }
    return `${err?.message || err}${extra}`;
}

// true = already following, false = not following, 'gone' = channel not found, null = couldn't tell
async function checkFollowing(sock, jid) {
    try {
        const meta = await sock.newsletterMetadata('jid', jid);
        const role = String(meta?.viewer_metadata?.role ?? meta?.viewerMetadata?.role ?? '').toUpperCase();
        return SUBSCRIBED.has(role);
    } catch (err) {
        return /404|not.?found|gone/i.test(`${err?.message} ${err?.output?.statusCode}`) ? 'gone' : null;
    }
}

async function followOne(sock, session, jid) {
    const base = retryBase();
    let last;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (session.sock !== sock) return 'abort';
        try {
            await sock.newsletterFollow(jid);
            return 'followed';
        } catch (err) {
            if (ALREADY.test(err?.message || '')) return 'followed';
            // "unexpected response structure" can also mean the follow already went through: ask WhatsApp.
            const state = await checkFollowing(sock, jid);
            if (state === true) return 'followed';
            if (state === 'gone') {
                console.log(`⚠️ [${session.tag}] channel ${jid.split('@')[0]} was not found on WhatsApp — check FOLLOW_CHANNELS`);
                return 'gone';
            }
            last = err;
            if (attempt < MAX_ATTEMPTS) await sleep(base * attempt * attempt);
        }
    }
    let raw = '';
    try { raw = JSON.stringify(last?.data)?.slice(0, 300) || ''; } catch { /* ignore */ }
    console.log(`⚠️ [${session.tag}] channel follow failed after ${MAX_ATTEMPTS} tries: ${describe(last)}${raw ? ' | ' + raw : ''}`);
    return 'failed';
}

async function followAll(sock, session) {
    const s = session.settings;
    if (!s.autoFollow || session.followBusy) return;
    session.followBusy = true;
    try {
        const done = new Set(s.followed || []);
        let changed = false;
        for (const jid of channels()) {
            if (done.has(jid) || session.sock !== sock) continue;
            const result = await followOne(sock, session, jid);
            if (result === 'followed') {
                done.add(jid); changed = true;
                console.log(`📡 [${session.tag}] following channel ${jid.split('@')[0]}`);
            }
            await sleep(800);
        }
        if (changed) { s.followed = [...done]; await session.save(); }
    } finally {
        session.followBusy = false;
    }
}

// Called on every 'open'; only does work once per socket-run, spaced out so a mass restore doesn't burst.
function onOpen(session, sock) {
    if (!channels().length || session.followRunFor === sock) return;
    session.followRunFor = sock;
    const base = parseInt(process.env.FOLLOW_DELAY_MS || '', 10);
    const delay = Number.isFinite(base) ? base : 3000 + Math.floor(Math.random() * 4000);
    setTimeout(() => followAll(sock, session).catch(() => {}), delay).unref?.();
}

const seen = new Set();
async function reactToPost(sock, session, raw) {
    const jid = raw.key?.remoteJid;
    if (!session.settings.channelReact || !channels().includes(jid) || !raw.key?.server_id) return;
    const id = String(raw.key.server_id), dedupe = `${session.number}:${jid}:${id}`;
    if (seen.has(dedupe)) return;
    if (seen.size > 2000) seen.clear();
    seen.add(dedupe);
    try {
        await sock.newsletterReactMessage(jid, id, EMOJIS[Math.floor(Math.random() * EMOJIS.length)]);
    } catch (err) {
        console.log(`⚠️ [${session.tag}] channel react failed: ${describe(err)}`);
    }
}

module.exports = { onOpen, followAll, reactToPost };
