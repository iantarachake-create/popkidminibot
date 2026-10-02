'use strict';
const fs = require('fs');
const path = require('path');

const f = dir => path.join(dir, 'creds.json');
const b = dir => path.join(dir, 'creds.bak.json');

function readsAsJson(file) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; }
}

// A crash mid-write can leave creds.json truncated. Keep a verified backup and
// fall back to it, so one bad write doesn't cost a user their linked session.
function ensureValidCreds(dir) {
    if (!fs.existsSync(f(dir))) return 'missing';
    if (readsAsJson(f(dir))) return 'ok';
    if (readsAsJson(b(dir))) {
        fs.copyFileSync(b(dir), f(dir));
        return 'restored';
    }
    return 'corrupt';
}

function backupCreds(dir) {
    try {
        if (readsAsJson(f(dir))) fs.copyFileSync(f(dir), b(dir));
    } catch { /* best effort */ }
}

module.exports = { ensureValidCreds, backupCreds };
