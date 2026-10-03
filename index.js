'use strict';
require('./config');
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { loadPlugins } = require('./lib/plugins');
const store = require('./lib/store');
const { SessionManager: manager, HttpError } = require('./lib/sessionManager');

const PORT = process.env.PORT || 3000;
const BOOT = Date.now();

for (const d of ['temp', 'tmp']) fs.mkdirSync(path.join(__dirname, d), { recursive: true });
loadPlugins();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- tiny in-memory rate limiter (per IP + route) ----
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
    const key = req.ip + '|' + req.path.replace(/\/\d+$/, '');
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) {
        return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a few minutes.' });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
};
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (!v.some(t => now - t < 15 * 60 * 1000)) hits.delete(k);
}, 10 * 60 * 1000).unref();

// ---- public API ----
app.post('/api/pair', limit(6, 10 * 60 * 1000), async (req, res, next) => {
    try {
        const number = String(req.body?.number || '').replace(/\D/g, '');
        if (!/^\d{8,15}$/.test(number)) {
            throw new HttpError('Enter your full number with country code, digits only (e.g. 2547XXXXXXXX).');
        }
        const code = await manager.pair(number);
        res.json({ ok: true, code, expiresInSec: 120 });
    } catch (err) { next(err); }
});

app.get('/api/status/:number', limit(90, 60 * 1000), (req, res) => {
    const number = req.params.number.replace(/\D/g, '');
    res.json({ ok: true, status: manager.status(number) });
});

app.get('/api/stats', (req, res) => res.json({ ok: true, ...manager.stats(), followsChannel: (global.followChannels || []).length > 0 }));

app.get('/ping', (req, res) => res.type('text').send('pong'));
app.get('/health', (req, res) => {
    res.json({ ok: true, storage: store.kind, uptimeSec: Math.floor((Date.now() - BOOT) / 1000), ...manager.stats(),
        rssMB: Math.round(process.memoryUsage().rss / 1048576) });
});

// ---- admin API (disabled unless ADMIN_PASSWORD / ADMIN_PASSWORD_HASH is set) ----
function adminAuth(req, res, next) {
    const hash = process.env.ADMIN_PASSWORD_HASH;
    const plain = process.env.ADMIN_PASSWORD;
    if (!hash && !plain) return res.status(404).json({ ok: false });
    const given = String(req.get('x-admin-password') || '');
    let ok = false;
    if (hash) {
        ok = require('bcryptjs').compareSync(given, hash);
    } else {
        const a = Buffer.from(given), b = Buffer.from(plain);
        ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    next();
}
app.get('/api/admin/sessions', limit(30, 60 * 1000), adminAuth, (req, res) =>
    res.json({ ok: true, ...manager.stats(), sessions: manager.list() }));
app.post('/api/admin/remove', limit(30, 60 * 1000), adminAuth, async (req, res) => {
    const number = String(req.body?.number || '').replace(/\D/g, '');
    await manager.destroy(number, { wipe: true });
    res.json({ ok: true });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500) console.error('API error:', err.message);
    res.status(status).json({ ok: false, error: err.message || 'Server error' });
});

// ---- boot ----
let server;
store.init().then(() => {
    server = app.listen(PORT, () => {
        console.log(`🌐 Mini bot server on :${PORT} (storage: ${store.kind})`);
        manager.startWatchdog();
        manager.restoreAll().catch(err => console.error('restoreAll failed:', err));
    });
    server.on('error', err => { console.error('Server error:', err); process.exit(1); }); // pm2 restarts us
}).catch(err => {
    console.error(`❌ Storage init failed (${store.kind}): ${err.message}`);
    process.exit(1); // fail loudly — never silently fall back and lose users' sessions
});

// Keep-alive for hosts that sleep without traffic (best paired with an external monitor on /ping)
const SELF = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL;
if (SELF) {
    const url = SELF.replace(/\/$/, '') + '/ping';
    setInterval(() => fetch(url).catch(() => {}), 4 * 60 * 1000).unref();
    console.log(`💓 Self-ping on ${url}`);
}

let closing = false;
async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`🛑 ${signal}: closing sockets (sessions are kept)`);
    await manager.shutdown();
    if (server) server.close(() => process.exit(0)); else process.exit(0);
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
