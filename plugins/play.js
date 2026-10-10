const axios = require('axios');
const yts = require('yt-search');
const { cmd } = require('../arslan');

const YTMP3_API = 'https://api.delirius.online/download/ytmp3';
const YT_ID_REGEX = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:\S*&)?v=|shorts\/|embed\/|v\/|live\/))([\w-]{11})/i;
const MAX_SECONDS = 30 * 60;

// ADVANCED POPKID PLAY UI
const TITLE = '┏━━━⟪ ◈ *𝗣𝗢𝗣𝗞𝗜𝗗 𝗣𝗟𝗔𝗬* ◈ ⟫';
const FOOTER = '╰━━━⟪ © 𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗣𝗢𝗣𝗞𝗜𝗗 ⟫';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

const box = (...lines) =>
    `${TITLE}\n┃\n${lines.filter(l => l !== null && l !== undefined).map(l => `┃  ⤷ ${l}`).join('\n')}\n┃\n┗━━━━━━━━━━━━⟫\n${FOOTER}`;

const clean = (s) => String(s || 'song').replace(/[<>:"/\\|?*\n\r]/g, '_').trim().slice(0, 100);

// Turn a query (name or link) into video metadata
async function resolveVideo(query) {
    const id = query.match(YT_ID_REGEX)?.[1];

    if (id) {
        try {
            const v = await yts({ videoId: id });
            if (v?.videoId) return v;
        } catch (_) { /* metadata is best-effort for links */ }

        return { videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
    }

    const res = await yts(query);
    const v = res?.videos?.[0];

    if (!v) throw new Error(`No song found for: ${query}`);

    return v;
}

async function fetchMp3(videoUrl, retries = 2) {
    let lastErr;

    for (let i = 0; i <= retries; i++) {
        try {
            const { data } = await axios.get(YTMP3_API, {
                params: { url: videoUrl },
                timeout: 90000
            });

            const link = data?.data?.download;

            if (!data?.status || !link || !/^https?:\/\//i.test(link)) {
                throw new Error('Download link not available for this video');
            }

            return data.data;
        } catch (err) {
            lastErr = err;

            if (i < retries) await wait(3000);
        }
    }

    throw lastErr;
}

cmd({
    pattern: 'play',
    name: 'play',
    category: 'Downloaders',
    aliases: ['ply', 'playy', 'pl', 'song'],
    description: 'Search YouTube and send a song as audio',
    filename: __filename
}, async (sock, m, args) => {
    const prefix = global.BOT_PREFIX || '.';
    const query = args && args.length ? args.join(' ').trim() : (m.quoted?.body || '').trim();

    if (!query) {
        return m.reply(box(
            '🎵 *𝗠𝗨𝗦𝗜𝗖 𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗥*',
            '◇ Enter a song name or YouTube link.',
            '',
            '📌 *𝗤𝗨𝗜𝗖𝗞 𝗘𝗫𝗔𝗠𝗣𝗟𝗘𝗦*',
            `${prefix}play harlem shake`,
            `${prefix}play https://youtu.be/dQw4w9WgXcQ`
        ));
    }

    if (query.length > 150) {
        return m.reply(box(
            '⚠️ *𝗜𝗡𝗩𝗔𝗟𝗜𝗗 𝗤𝗨𝗘𝗥𝗬*',
            'Keep your search under 150 characters.'
        ));
    }

    try {
        await m.react('⌛');

        const video = await resolveVideo(query);
        const videoUrl = video.url || `https://www.youtube.com/watch?v=${video.videoId}`;

        if (video.seconds && video.seconds > MAX_SECONDS) {
            await m.react('❌');

            return m.reply(box(
                '⛔ *𝗗𝗨𝗥𝗔𝗧𝗜𝗢𝗡 𝗟𝗜𝗠𝗜𝗧*',
                `${video.title || 'This video'} is ${video.timestamp}.`,
                `Maximum allowed: ${MAX_SECONDS / 60} minutes.`
            ));
        }

        const mp3 = await fetchMp3(videoUrl);

        // Prefer YouTube search metadata when available
        const title = video.title || (mp3.title && mp3.title !== '-' ? mp3.title : 'Unknown Song');
        const thumbnail = video.thumbnail || video.image || '';
        const author = video.author?.name || '';

        const caption = box(
            '🎧 *𝗡𝗢𝗪 𝗣𝗥𝗢𝗖𝗘𝗦𝗦𝗘𝗗*',
            '',
            '🎵 *𝗧𝗥𝗔𝗖𝗞 𝗧𝗜𝗧𝗟𝗘*',
            title,
            author ? `👤 *𝗔𝗥𝗧𝗜𝗦𝗧:* ${author}` : null,
            video.timestamp ? `⏱️ *𝗗𝗨𝗥𝗔𝗧𝗜𝗢𝗡:* ${video.timestamp}` : null,
            video.views ? `👁️ *𝗩𝗜𝗘𝗪𝗦:* ${Number(video.views).toLocaleString()}` : null,
            '',
            '⚡ *𝗣𝗢𝗣𝗞𝗜𝗗 𝗠𝗨𝗦𝗜𝗖 𝗦𝗬𝗦𝗧𝗘𝗠*',
            'Your audio is ready below.'
        );

        // Song card with thumbnail + details
        if (thumbnail) {
            await sock.sendMessage(m.from, {
                image: { url: thumbnail },
                caption
            }).catch(() => {});
        } else {
            await m.reply(caption);
        }

        // Send the audio itself
        const fileName = `${clean(title)}.mp3`;

        try {
            await sock.sendMessage(m.from, {
                audio: { url: mp3.download },
                mimetype: 'audio/mpeg',
                fileName
            });
        } catch (e) {
            // Fallback: download to a buffer first, then upload
            const res = await axios.get(mp3.download, {
                responseType: 'arraybuffer',
                timeout: 180000,
                maxContentLength: 100 * 1024 * 1024
            });

            await sock.sendMessage(m.from, {
                audio: Buffer.from(res.data),
                mimetype: 'audio/mpeg',
                fileName
            });
        }

        await m.react('✅');

    } catch (err) {
        console.error('[PLAY] Error:', err.message);

        await m.react('❌').catch(() => {});

        await m.reply(box(
            '❌ *𝗣𝗟𝗔𝗬 𝗘𝗥𝗥𝗢𝗥*',
            err.message,
            'Please try again shortly.',
            '◇ *𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗣𝗢𝗣𝗞𝗜𝗗*'
        ));
    }
});
