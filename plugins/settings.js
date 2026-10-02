// Per-session settings. Each user only changes THEIR OWN linked account.
const { cmd } = require('../arslan');

const guard = fn => async (sock, m, args) => {
    if (!m.isOwner) return m.reply('❌ Owner only.');
    if (!sock.session) return m.reply('❌ Session not ready.');
    return fn(sock, m, args, sock.session);
};

const persist = s => s.save();
const P = () => global.BOT_PREFIX;

function toggle(pattern, key, label) {
    cmd({
        pattern, name: pattern, category: 'Admin',
        description: `${label} on/off (owner only)`, filename: __filename
    }, guard(async (sock, m, args, s) => {
        const v = (args[0] || '').toLowerCase();
        if (v !== 'on' && v !== 'off') return m.reply(`Usage: ${P()}${pattern} on|off`);
        s.settings[key] = v === 'on';
        persist(s);
        return m.reply(`✅ ${label}: ${v.toUpperCase()}`);
    }));
}

toggle('autoview', 'autoView', 'Auto view status');
toggle('autolike', 'autoLike', 'Auto like status');
toggle('autoread', 'autoRead', 'Auto read messages');
toggle('anticall', 'antiCall', 'Anti-call');

cmd({
    pattern: 'mode', name: 'mode', category: 'Admin',
    description: 'public or private (owner only)', filename: __filename
}, guard(async (sock, m, args, s) => {
    const v = (args[0] || '').toLowerCase();
    if (v !== 'public' && v !== 'private') return m.reply(`Usage: ${P()}mode public|private`);
    s.settings.mode = v;
    persist(s);
    return m.reply(`✅ Mode: ${v.toUpperCase()}`);
}));

cmd({
    pattern: 'presence', name: 'presence', category: 'Admin',
    description: 'none | typing | recording | online (owner only)', filename: __filename
}, guard(async (sock, m, args, s) => {
    const v = (args[0] || '').toLowerCase();
    if (!['none', 'typing', 'recording', 'online'].includes(v)) {
        return m.reply(`Usage: ${P()}presence none|typing|recording|online`);
    }
    s.settings.presence = v;
    persist(s);
    return m.reply(`✅ Presence: ${v}`);
}));

cmd({
    pattern: 'settings', name: 'settings', category: 'Admin',
    description: 'Show your bot settings (owner only)', filename: __filename
}, guard(async (sock, m, args, s) => {
    const x = s.settings;
    const on = v => (v ? '✅ ON' : '❌ OFF');
    return m.reply([
        '┏▣ ◈ *𝗦𝗘𝗧𝗧𝗜𝗡𝗚𝗦* ◈', '┃',
        `┃➽ Mode : ${x.mode.toUpperCase()}`,
        `┃➽ Auto view status : ${on(x.autoView)}`,
        `┃➽ Auto like status : ${on(x.autoLike)}`,
        `┃➽ Auto read : ${on(x.autoRead)}`,
        `┃➽ Anti-call : ${on(x.antiCall)}`,
        `┃➽ Presence : ${x.presence}`,
        '┃', '┗▣'
    ].join('\n'));
}));
