'use strict';
const fs = require('fs');
const path = require('path');
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const creds = require('../creds');
const settingsLib = require('../settings');

// Local-disk backend (used when DATABASE_URL is not set). Same interface as PgStore.
class FileStore {
    constructor(root) {
        this.root = path.resolve(root || process.env.SESSIONS_DIR || './sessions');
        this.kind = 'files';
    }
    dir(number) { return path.join(this.root, number); }

    async init() { fs.mkdirSync(this.root, { recursive: true }); }

    async begin(number) {
        await this.remove(number);
        fs.mkdirSync(this.dir(number), { recursive: true });
    }

    async check(number) { return creds.ensureValidCreds(this.dir(number)); }

    async authState(number) {
        const dir = this.dir(number);
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        return { state, saveCreds: async () => { await saveCreds(); creds.backupCreds(dir); } };
    }

    async markPaired(number) {
        fs.writeFileSync(path.join(this.dir(number), '.paired'), String(Date.now()));
    }

    async loadSettings(number) { return settingsLib.load(this.dir(number)); }
    async saveSettings(number, s) { settingsLib.save(this.dir(number), s); }

    async remove(number) {
        if (!/^\d{6,20}$/.test(number)) return; // never rm anything that isn't a plain number dir
        try { fs.rmSync(this.dir(number), { recursive: true, force: true }); } catch { /* ignore */ }
    }

    async listPaired() {
        return fs.readdirSync(this.root, { withFileTypes: true })
            .filter(d => d.isDirectory() && /^\d{6,20}$/.test(d.name))
            .map(d => d.name)
            .filter(n => fs.existsSync(path.join(this.dir(n), '.paired')) && fs.existsSync(path.join(this.dir(n), 'creds.json')));
    }

    async cleanupStale(maxAgeMs) {
        const paired = new Set(await this.listPaired());
        for (const d of fs.readdirSync(this.root, { withFileTypes: true })) {
            if (!d.isDirectory() || !/^\d{6,20}$/.test(d.name) || paired.has(d.name)) continue;
            if (Date.now() - fs.statSync(this.dir(d.name)).mtimeMs > maxAgeMs) await this.remove(d.name);
        }
    }
}

module.exports = { FileStore };
