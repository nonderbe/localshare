# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start the server
npm start
# or
node server.js

# The server defaults to port 10000, overridable via PORT env var
PORT=3000 node server.js
```

No test suite or linter is configured.

## Architecture

LocalShare is a browser-based peer-to-peer file sharing app. Files never touch the server — the server only handles WebSocket signaling.

**`server.js`** — Express + WebSocket server:
- Redirects apex domain, `/index.html`, and plain HTTP to the canonical `https://www.local-share.com` host/path (see indexing note below)
- Maintains a `Map<WebSocket, { id, sharedFiles[] }>` of connected clients
- Handles 4 WebSocket message types: `register`, `share`, `stopSharing`, `signal`
- `signal` messages are forwarded directly between peers (WebRTC signaling relay)
- `broadcastUpdate()` fans out device count + file metadata to all clients on any state change
- Shared file entries expire after 72 hours (checked on every broadcast)
- `/submit-suggestion` POST route emails suggestions via nodemailer (requires `EMAIL_USER` / `EMAIL_PASS` env vars)

**`stats.js`** — local usage-stats logging, required by `server.js`:
- Records, per connection: a salted-hash of the visitor's IP (`sha256(ip + STATS_IP_SALT)`, raw IP never stored) and their country (offline lookup via `ip-location-api`, country-only mode); and per share event: file size or text length. Never records filenames, text labels/content, or download completions (the server has no visibility into whether a shared file is ever actually downloaded — that happens directly over WebRTC).
- Storage: `data/stats.db` (gitignored, created at runtime), accessed via Node's built-in `node:sqlite`.
- Fails open: if `STATS_IP_SALT` isn't set, logs one warning and all recording calls become no-ops — the signaling server's operation never depends on this working.
- `scripts/update-geo-db.js` (`npm run updatedb`) does a one-time build of the local geo-IP database; normally unnecessary after initial setup since `ip-location-api` auto-updates it (twice weekly) while the server process keeps running.
- `scripts/backfill-historical-shares.js` is a one-off maintenance tool (already run once) that extracted historical file/text share events from the pre-existing pm2 log — not part of normal operation.

**`public/client.js`** — All peer-to-peer logic runs in the browser:
- On load, opens a WebSocket to the server and registers to get a `clientId`
- File metadata (name, size, timestamp, ownerId) is shared via WebSocket; actual file bytes never go through the server
- Downloads use WebRTC data channels: requester creates an offer → server relays SDP/ICE signals → direct P2P data channel opens → sender streams file in 64 KB chunks
- A single `peerConnection` / `dataChannel` pair is reused; a `downloadQueue` serializes sequential downloads
- `transfers` Map tracks in-flight transfers keyed by a unique `fileId` (timestamp + filename), used to drive per-file progress bars
- STUN: `stun.l.google.com:19302`; the offer-side uses only STUN, the answer-side also includes a TURN fallback

**`public/`** — Static HTML/CSS pages (`index.html`, `about.html`, `faq.html`, `suggestions.html`, `styles.css`), plus `favicon.svg`/`favicon-*.png`/`apple-touch-icon.png`, `og-image.jpg`, and `manifest.json` for search/social/PWA metadata.

**Tesla third-party app public key** (`/.well-known/appspecific/com.tesla.3p.public-key.pem`) is no longer served by this app. It's now served directly on the home server by a standalone script, `tesla-pem.py`, listening on port 10001 — separate from this Express app's port 10000. This repo's `.wellknown/appspecific/com.tesla.3p.public-key.pem` and `public/.wellknown/appspecific/com.tesla.3p.public-key.pem` files are stale leftovers from the old in-app-serving approach and are no longer what's actually live.

## Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP/WS listen port (default: `10000`) |
| `EMAIL_USER` | Gmail address for suggestion emails |
| `EMAIL_PASS` | Gmail app password for suggestion emails |
| `NOTIFY_EMAIL` | Recipient address for suggestion emails |
| `STATS_IP_SALT` | Secret salt mixed into hashed visitor IPs before storing in `data/stats.db`; IPs are never stored raw. Set only in the server's `ecosystem.config.js` — not in this repo. |

## Google Search Console indexing

Google previously reported several homepage URL variants (apex domain, non-www, `/index.html`) as "Alternate page with proper canonical tag" / stuck unindexed, because the server didn't enforce the canonical host used in the `<link rel="canonical">` tags. `server.js` now 301-redirects apex → `www`, `/index.html` → `/`, and HTTP → HTTPS in one hop.

## Deployment

The app runs on a home server, managed by `pm2` (process name `local-share.com`, config in `ecosystem.config.js` on the server — not checked into this repo since it contains the email credentials).

**Access:** SSH key-based auth, no passwords.
- Local machine has a dedicated keypair: `~/.ssh/id_ed25519_localshare` (public key installed in the server's `root` `authorized_keys`).
- `~/.ssh/config` has a `Host localshare` entry (`root@192.168.176.93`) so the server is reachable via `ssh localshare`.

**Manual deploy:**
```bash
ssh localshare "cd /root/local-share.com/localshare && git pull origin main && npm install --omit=dev && pm2 restart local-share.com"
```

**Automatic deploy:** `POST /deploy-webhook` in `server.js`. A GitHub webhook (repo Settings → Webhooks) calls this on every push, HMAC-signed with the `DEPLOY_WEBHOOK_SECRET` env var (set in `ecosystem.config.js` on the server, verified with `crypto.timingSafeEqual`). On a valid signature and `push` to `refs/heads/main`, it responds immediately, then spawns a detached `git pull origin main && npm install --omit=dev && pm2 restart local-share.com` (output logged to `/var/log/localshare-deploy.log` on the server) so the restart doesn't cut off the HTTP response.

A GitHub Actions self-hosted runner was considered instead but ruled out: this server has no port-forwarded/public SSH access (it sits behind a Cloudflare Tunnel), so a GitHub-hosted runner can't reach it directly, and the disk is nearly full (~4.9GB, was at 96% used) — no room for a second full runner alongside the one already running here for the unrelated `belbudget` project. The webhook approach needs no new service and works over the same tunnel that already serves the site.

## Log management

The pm2 out-log (`/root/.pm2/logs/local-share.com-out-0.log`) is capped at 20MB via `pm2-logrotate` (`pm2 install pm2-logrotate; pm2 set pm2-logrotate:max_size 20M; pm2 set pm2-logrotate:retain 1; pm2 set pm2-logrotate:compress true`) — one-time manual server-side config, not in this repo, same category as `ecosystem.config.js`. `retain 1` and `compress true` are deliberate given the server's very limited free disk: the module's default retain count would otherwise let old rotated copies quietly consume the remaining headroom.

If a log ever needs manual trimming again (e.g. if `pm2-logrotate` is ever uninstalled or misconfigured), do it in place without restarting the process — `tail -c 20M file > /tmp/trimmed.log && cat /tmp/trimmed.log > file && rm /tmp/trimmed.log`. Using `cat ... > file` (not `mv`) preserves the file's inode, so pm2's already-open append-mode file descriptor keeps writing correctly afterward; `mv`/`rm`+recreate would orphan that descriptor and silently lose all future log output until a restart.
