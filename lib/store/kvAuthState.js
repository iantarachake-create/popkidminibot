'use strict';
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

// Baileys auth state on top of any key/value backend:
//   kv.get(number, names[]) -> { name: string }   kv.set(number, { name: string|null })
const ser = v => JSON.stringify(v, BufferJSON.replacer);
const de = s => JSON.parse(s, BufferJSON.reviver);

async function kvAuthState(kv, number) {
    const saved = (await kv.get(number, ['creds'])).creds;
    const creds = saved ? de(saved) : initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const rows = await kv.get(number, ids.map(id => `${type}-${id}`));
                    const out = {};
                    for (const id of ids) {
                        let v = rows[`${type}-${id}`];
                        if (v) {
                            v = de(v);
                            if (type === 'app-state-sync-key' && v) {
                                v = proto.Message.AppStateSyncKeyData.fromObject(v);
                            }
                        }
                        out[id] = v || null;
                    }
                    return out;
                },
                set: async data => {
                    const entries = {};
                    for (const type of Object.keys(data)) {
                        for (const id of Object.keys(data[type])) {
                            const v = data[type][id];
                            entries[`${type}-${id}`] = v ? ser(v) : null;
                        }
                    }
                    if (Object.keys(entries).length) await kv.set(number, entries);
                }
            }
        },
        saveCreds: () => kv.set(number, { creds: ser(creds) })
    };
}

module.exports = { kvAuthState };
