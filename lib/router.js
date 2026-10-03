'use strict';
const baileys = require('@whiskeysockets/baileys');
const serialize = require('../handler');
const channel = require('./channel');

const lidCache = new Map();

async function resolveStatusParticipant(sock, raw) {
    const p = raw.key.participant;
    if (!p || !p.endsWith('@lid')) return p;
    const lid = p.split('@')[0].split(':')[0];
    if (lidCache.has(lid)) return `${lidCache.get(lid)}@s.whatsapp.net`;

    const pn = raw.key.participantPn || raw.key.senderPn;
    if (pn) {
        const num = String(pn).split('@')[0].split(':')[0];
        lidCache.set(lid, num);
        return `${num}@s.whatsapp.net`;
    }
    try {
        const r = await sock.signalRepository?.lidMapping?.getPNForLID?.(p);
        const num = r ? String(r).split('@')[0].split(':')[0].replace(/\D/g, '') : '';
        if (num.length >= 7) {
            if (lidCache.size > 5000) lidCache.clear();
            lidCache.set(lid, num);
            return `${num}@s.whatsapp.net`;
        }
    } catch { /* fall through */ }
    return p;
}

const REACTABLE = ['imageMessage', 'videoMessage', 'extendedTextMessage', 'conversation', 'audioMessage'];
const EMOJIS = ['❤️', '🔥', '💯', '✨', '😍', '🎉', '💚', '🤍'];

async function handleStatus(sock, session, raw) {
    const s = session.settings;
    if (raw.key.fromMe) return;
    if (s.autoView) await sock.readMessages([raw.key]).catch(() => {});
    if (!s.autoLike) return;

    const now = Date.now();
    if (now - (session.lastStatusReact || 0) < 5000) return; // throttle bursts
    session.lastStatusReact = now;

    const type = Object.keys(raw.message || {})[0];
    if (!REACTABLE.includes(type)) return;

    const jid = await resolveStatusParticipant(sock, raw);
    if (!jid) return;
    const self = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
    await sock.sendMessage('status@broadcast', {
        react: {
            text: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
            key: { remoteJid: 'status@broadcast', id: raw.key.id, participant: jid }
        }
    }, { statusJidList: [jid, self].filter(Boolean) }).catch(() => {});
}

function quickText(message) {
    return message?.conversation
        || message?.extendedTextMessage?.text
        || message?.imageMessage?.caption
        || message?.videoMessage?.caption
        || message?.documentMessage?.caption
        || message?.buttonsResponseMessage?.selectedButtonId
        || message?.listResponseMessage?.singleSelectReply?.selectedRowId
        || message?.templateButtonReplyMessage?.selectedId
        || message?.interactiveResponseMessage?.buttonId
        || '';
}

async function handleOne(sock, session, raw) {
    if (!raw?.message || !raw.key?.remoteJid) return;
    const jid = raw.key.remoteJid;
    const s = session.settings;

    if (jid === 'status@broadcast') return handleStatus(sock, session, raw);
    if (jid.endsWith('@newsletter') || jid === 'broadcast') return;
    if (raw.key.id && raw.key.id.startsWith('BAE5')) return; // our own library-generated messages

    if (s.autoRead && !raw.key.fromMe) sock.readMessages([raw.key]).catch(() => {});

    const normalized = baileys.normalizeMessageContent
        ? (baileys.normalizeMessageContent(raw.message) || raw.message)
        : raw.message;
    const msg = normalized === raw.message ? raw : { ...raw, message: normalized };

    // Cheap prefilter: don't pay for group metadata / serialization on normal chatter.
    const text = quickText(normalized);
    const prefix = global.BOT_PREFIX;
    if (!text || !text.startsWith(prefix)) return;

    const m = await serialize(sock, msg);
    if (s.mode === 'private' && !m.isOwner) return;

    if (s.presence !== 'none') {
        const map = { typing: 'composing', recording: 'recording', online: 'available' };
        sock.sendPresenceUpdate(map[s.presence], m.from).catch(() => {});
    }

    const args = m.body.slice(prefix.length).trim().split(/\s+/);
    const command = (args.shift() || '').toLowerCase();
    const plugin = global.plugins.get(command);
    if (!plugin) return;

    try {
        await plugin.execute(sock, m, args);
    } catch (err) {
        console.error(`❌ [${session.tag}] command "${command}" failed:`, err.message);
        m.reply('❌ Error running command.').catch(() => {});
    }
}

function attachRouter(sock, session) {
    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (session.sock !== sock) return;
        for (const raw of messages) {
            if (raw.key?.remoteJid?.endsWith('@newsletter')) channel.reactToPost(sock, session, raw).catch(() => {});
        }
        if (type !== 'notify') return;
        // Fire-and-forget per message so one slow download never blocks the session.
        for (const raw of messages) {
            handleOne(sock, session, raw).catch(err =>
                console.error(`❌ [${session.tag}] router error:`, err.message));
        }
    });

    sock.ev.on('call', async calls => {
        if (session.sock !== sock || !session.settings.antiCall) return;
        for (const call of calls) {
            if (call.status !== 'offer') continue;
            try {
                await sock.rejectCall(call.id, call.from);
                await sock.sendMessage(call.from, { text: '🚫 Calls are disabled for this bot.' });
            } catch { /* ignore */ }
        }
    });
}

module.exports = { attachRouter };
