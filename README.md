# Popkid Mini Bot (multi-session)

Visitors open your site, type their number, get an 8-character pairing code, link it in
WhatsApp → Linked devices, and their own bot goes live. No SESSION_ID. Every user gets an
isolated session; one server runs many of them.

## Deploy on Render (everything is already in this project)
1. In Supabase reset your database password, then open `bot.env` and replace `PASTE_NEW_PASSWORD_HERE`.
2. Put the extracted project in a **private** GitHub repo (`bot.env` holds secrets).
3. Render → New → **Blueprint** (reads `render.yaml`) or New → Web Service
   (build `npm install`, start `npm start`, region Frankfurt). No env vars needed.
4. Open your `https://<app>.onrender.com` URL: that is the pairing page. `/health` should say `"storage":"postgres"`.

Local test: `npm install && npm run dev`.

## Storage (database)
Set `DATABASE_URL` and **all users' data lives in Postgres**: linked sessions (credentials + Signal
keys), per-user settings, and the paired/unpaired state. Redeploys and restarts no longer log anyone out.
Tables are created automatically on boot (`wa_sessions`, `wa_auth`, `wa_settings`).

- Settings are read from `bot.env`; real environment variables (Render's Environment tab) override it.
- Set `ENCRYPTION_KEY` too. Stored credentials are then encrypted (AES-256-GCM); without it, anyone
  who can read the database can hijack every linked WhatsApp. Back the key up — losing it loses all sessions.
- If `DATABASE_URL` is unset, it falls back to local files in `SESSIONS_DIR` (needs a persistent disk).
- If the database is unreachable at boot, the process exits and pm2 retries. It never silently falls
  back to files.
- Run only ONE instance per database. Two instances using the same session get kicked off by WhatsApp.

## Uptime design
- Per-session auto-reconnect with exponential backoff + jitter (2s → 60s, never gives up).
- Right-after-pairing restart (515) handled; phone-side logout wipes that session only.
- Watchdog (60s) rebuilds dead/stuck sockets.
- File mode: verified backup of `creds.json`. DB mode: per-user write queue, so credential writes land in order.
- Staggered restore at boot (`RESTORE_STAGGER_MS`) so a restart doesn't stampede WhatsApp.
- Graceful shutdown closes sockets **without** logging out, so sessions survive restarts.
- `/ping` and `/health` for uptime monitors; optional `SELF_URL` self-ping.
- Group metadata cached per session; commands only serialized when they match the prefix.

## Capacity
Each live session is its own WhatsApp socket and costs RAM. Start with `MAX_SESSIONS=50`
and watch `/health` (`rssMB`) before raising it.

## Per-user commands (owner = the linked number)
`.mode public|private`, `.autoview`, `.autolike`, `.autoread`, `.anticall`,
`.presence none|typing|recording|online`, `.settings` — stored per session in
`sessions/<number>/settings.json`. Default is public mode, everything else off.

## What was removed from POPKID-MD (and why)
These touched global/server state, which is unsafe when many users share one process:
`update`, `host`, `sudo`, `botonoff`, `mode` (old), `setprefix`, `self`, `setmenuimage`,
`autofeature`, `cmdreact`, `antilink`, `antidelete`, `chatbot`, `welcome`, `deltmp`,
`backup/restore`, global owners. The old `.update` in particular would let any user overwrite
the server's code. Add features back as per-session settings, not globals.

Also changed: the bot no longer stays "online" 24/7 (`markOnlineOnConnect: false`) so users keep
phone notifications, and it does not auto-follow/react to your channel unless you set
`FOLLOW_CHANNEL`.

## Admin API (optional)
Set `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`, bcrypt), then send header `x-admin-password`:
`GET /api/admin/sessions`, `POST /api/admin/remove {"number":"2547…"}`.

## Notes
- Only add `DEV_NUMBERS` if you accept that those numbers get dev rights on every user's session.
- You are responsible for how the service is used: tell users plainly that their WhatsApp account
  is being linked to your server, and that unofficial clients carry some ban risk.
