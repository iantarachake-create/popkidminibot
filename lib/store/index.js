'use strict';
// DATABASE_URL set  -> Postgres (survives redeploys on Render etc.)
// not set           -> local files in SESSIONS_DIR (local dev / hosts with a persistent disk)
const url = process.env.DATABASE_URL;

if (url && /PASTE_NEW_PASSWORD_HERE/.test(url)) {
    console.error('❌ bot.env still contains PASTE_NEW_PASSWORD_HERE. Put your Supabase database password in DATABASE_URL.');
    process.exit(1);
}
if (!url && process.env.RENDER && process.env.ALLOW_FILE_STORAGE !== 'true') {
    // Render's disk is wiped on every deploy: refuse to run rather than silently lose every user's session.
    console.error('❌ DATABASE_URL is missing. Fill it in bot.env (or the Render Environment tab).');
    process.exit(1);
}

if (url) {
    module.exports = require('./pgStore').createPgStore();
} else {
    const { FileStore } = require('./fileStore');
    module.exports = new FileStore();
}
