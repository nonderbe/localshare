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

**`public/client.js`** — All peer-to-peer logic runs in the browser:
- On load, opens a WebSocket to the server and registers to get a `clientId`
- File metadata (name, size, timestamp, ownerId) is shared via WebSocket; actual file bytes never go through the server
- Downloads use WebRTC data channels: requester creates an offer → server relays SDP/ICE signals → direct P2P data channel opens → sender streams file in 64 KB chunks
- A single `peerConnection` / `dataChannel` pair is reused; a `downloadQueue` serializes sequential downloads
- `transfers` Map tracks in-flight transfers keyed by a unique `fileId` (timestamp + filename), used to drive per-file progress bars
- STUN: `stun.l.google.com:19302`; the offer-side uses only STUN, the answer-side also includes a TURN fallback

**`public/`** — Static HTML/CSS pages (`index.html`, `about.html`, `faq.html`, `suggestions.html`, `styles.css`), plus `favicon.svg`/`favicon-*.png`/`apple-touch-icon.png`, `og-image.jpg`, and `manifest.json` for search/social/PWA metadata.

**`.wellknown/appspecific/com.tesla.3p.public-key.pem`** — Tesla third-party app public key served at `/.well-known/appspecific/com.tesla.3p.public-key.pem`. Note: the directory is named `.wellknown` (no hyphen) but Express serves it under `/.well-known` — verify routing if this path changes. This path is also excluded in spirit from the host-canonicalization redirect (see below): if any third-party verifier ever fetches it from the apex domain without following redirects, that fetch will fail — check this if Tesla verification breaks.

## Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP/WS listen port (default: `10000`) |
| `EMAIL_USER` | Gmail address for suggestion emails |
| `EMAIL_PASS` | Gmail app password for suggestion emails |
| `NOTIFY_EMAIL` | Recipient address for suggestion emails |

## Google Search Console indexing

Google previously reported several homepage URL variants (apex domain, non-www, `/index.html`) as "Alternate page with proper canonical tag" / stuck unindexed, because the server didn't enforce the canonical host used in the `<link rel="canonical">` tags. `server.js` now 301-redirects apex → `www`, `/index.html` → `/`, and HTTP → HTTPS in one hop.

## Deployment

The app runs on a home server, managed by `pm2` (process name `local-share.com`, config in `ecosystem.config.js` on the server — not checked into this repo since it contains the email credentials).

**Access:** SSH key-based auth, no passwords.
- Local machine has a dedicated keypair: `~/.ssh/id_ed25519_localshare` (public key installed in the server's `root` `authorized_keys`).
- `~/.ssh/config` has a `Host localshare` entry (`root@192.168.176.93`) so the server is reachable via `ssh localshare`.

**Manual deploy:**
```bash
ssh localshare "cd /root/local-share.com/localshare && git pull origin main && pm2 restart local-share.com"
```

**Automatic deploy:** `POST /deploy-webhook` in `server.js`. A GitHub webhook (repo Settings → Webhooks) calls this on every push, HMAC-signed with the `DEPLOY_WEBHOOK_SECRET` env var (set in `ecosystem.config.js` on the server, verified with `crypto.timingSafeEqual`). On a valid signature and `push` to `refs/heads/main`, it responds immediately, then spawns a detached `git pull origin main && pm2 restart local-share.com` (output logged to `/var/log/localshare-deploy.log` on the server) so the restart doesn't cut off the HTTP response.

A GitHub Actions self-hosted runner was considered instead but ruled out: this server has no port-forwarded/public SSH access (it sits behind a Cloudflare Tunnel), so a GitHub-hosted runner can't reach it directly, and the disk is nearly full (~4.9GB, was at 96% used) — no room for a second full runner alongside the one already running here for the unrelated `belbudget` project. The webhook approach needs no new service and works over the same tunnel that already serves the site.
