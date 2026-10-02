'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    mode: 'public',      // 'public' | 'private' (private = only the linked account can use commands)
    autoView: false,     // mark contacts' statuses as viewed
    autoLike: false,     // react to statuses
    autoRead: false,     // mark incoming messages as read
    antiCall: false,     // reject incoming calls
    presence: 'none'     // 'none' | 'typing' | 'recording' | 'online'
};

function load(dir) {
    try {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) };
    } catch {
        return { ...DEFAULTS };
    }
}

function save(dir, settings) {
    try {
        const file = path.join(dir, 'settings.json');
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
        fs.renameSync(tmp, file);
    } catch (err) {
        console.error('settings save failed:', err.message);
    }
}

module.exports = { DEFAULTS, load, save };
