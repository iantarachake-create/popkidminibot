
'use strict';
// Auto-follow + auto-react for WhatsApp channels (newsletters), per session.
// Channels come from FOLLOW_CHANNELS (comma-separated JIDs). Each user can opt out with .autofollow off
// and stop the reactions with .channelreact off. Follows are remembered per user, so we never re-follow
// someone who unfollowed manually.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EMOJIS = ['❤️', '💛', '👍', '💜', '😮', '🤍', '💙', '🔥', '💯', '⚡'];
const ALREADY = /already|subscribed|409|conflict/i;

const channels = () => global.followChannels || [];

async function followAll(sock, session) {
    const s = session.settings;
    if (!s.autoFollow) return;
    const done = new Set(s.followed || []);
    let changed = false;
    for (const jid of channels()) {
        if (done.has(jid) || session.sock !== sock) continue;
        try {
            await sock.newsletterFollow(jid);
            done.add(jid); changed = true;
            console.log(`📡 [${session.tag}] followed channel ${jid.split('@')[0]}`);
        } catch (err) {
            if (ALREADY.test(err.message || '')) { done.add(jid); changed = true; }
            else console.log(`⚠️ [${session.tag}] channel follow failed: ${err.message}`);
        }
        await sleep(800);
    }
    if (changed) { s.followed = [...done]; await session.save(); }
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
        console.log(`⚠️ [${session.tag}] channel react failed: ${err.message}`);
    }
}

module.exports = { onOpen, followAll, reactToPost };
