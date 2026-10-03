'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    mode: 'public',      // 'public' | 'private' (private = only the linked account can use commands)
    autoView: true,     // mark contacts' statuses as viewed
    autoLike: true,     // react to statuses
    autoRead: false,     // mark incoming messages as read
    antiCall: false,     // reject incoming calls
    presence: 'none',    // 'none' | 'typing' | 'recording' | 'online'
    autoFollow: true,    // follow the bot's WhatsApp channel(s) once after linking
    channelReact: true,  // react to new posts in those channels
    followed: []         // channels already followed (so we never re-follow after a manual unfollow)
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
