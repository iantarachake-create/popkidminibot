// Load settings from bot.env (or .env) shipped in the project. Real environment variables win.
(function loadEnvFile() {
    const fs = require('fs'), path = require('path');
    for (const name of ['bot.env', '.env']) {
        const file = path.join(__dirname, name);
        if (!fs.existsSync(file)) continue;
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!m || line.trim().startsWith('#')) continue;
            let v = m[2];
            if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
            if (v !== '' && process.env[m[1]] === undefined) process.env[m[1]] = v;
        }
    }
})();

// Shared, read-only settings. Per-user settings live in sessions/<number>/settings.json
global.BOT_PREFIX = process.env.PREFIX || '.';
global.owners = []; // owner = the linked account itself, resolved per session in handler.js
global.dev = (process.env.DEV_NUMBERS || '').split(',')
    .map(n => n.trim().replace(/\D/g, '')).filter(Boolean)
    .map(n => `${n}@s.whatsapp.net`);
global.menuImage = 'https://i.ibb.co/GQNSbb6D/IMG-20260921-WA0012.jpg';
global.ownerName = '😷popkid😷';

// WhatsApp channels every session follows (and reacts to). Comma-separated JIDs, empty = feature off.
global.followChannels = (process.env.FOLLOW_CHANNELS || process.env.FOLLOW_CHANNEL || '120363426692424154@newsletter')
    .split(',').map(x => x.trim()).filter(x => /^\d+@newsletter$/.test(x));
