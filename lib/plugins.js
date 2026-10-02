'use strict';
const fs = require('fs');
const path = require('path');

// Plugins are loaded ONCE and shared by every session. Each command receives
// the calling session's own `sock`, so no state is shared between users.
function loadPlugins() {
    require('../arslan');
    const plugins = global.plugins;
    const dir = path.join(__dirname, '..', 'plugins');
    for (const file of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
        try {
            const before = plugins.size;
            const mod = require(path.join(dir, file));
            if (plugins.size === before && mod && mod.name && typeof mod.execute === 'function') {
                plugins.set(mod.name.toLowerCase(), mod);
                (mod.aliases || []).forEach(a => plugins.set(a.toLowerCase(), mod));
            }
        } catch (err) {
            console.error(`❌ plugin ${file} failed to load: ${err.message}`);
        }
    }
    console.log(`📦 ${new Set(plugins.values()).size} commands loaded`);
    return plugins;
}

module.exports = { loadPlugins };
