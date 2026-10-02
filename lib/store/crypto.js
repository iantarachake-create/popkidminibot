'use strict';
const crypto = require('crypto');

// Optional encryption at rest for everything stored in the database.
// Set ENCRYPTION_KEY (any long random string). If you lose it, stored sessions become unreadable.
const secret = process.env.ENCRYPTION_KEY;
const key = secret ? crypto.createHash('sha256').update(secret).digest() : null;
const PREFIX = 'e1:';

function encrypt(text) {
    if (!key) return text;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(text) {
    if (!text.startsWith(PREFIX)) return text;
    if (!key) throw new Error('Stored data is encrypted but ENCRYPTION_KEY is not set');
    const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, enabled: !!key };
