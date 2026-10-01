const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');
const stats = require('./stats');
const diskAlert = require('./disk-alert');
const { parseNetwork, describeNetwork, createLinkStore } = require('./network');

const app = express();
const port = process.env.PORT || 10000;

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
  console.error(`Error: Public directory not found at ${publicPath}`);
  process.exit(1);
}

app.set('trust proxy', true);

// Redirect non-canonical hosts/paths (apex domain, http, /index.html) to the
// canonical https://www.local-share.com URL used in canonical tags and the
// sitemap, so Google consolidates duplicate URLs instead of leaving them
// unindexed as separate alternates.
app.use((req, res, next) => {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  let host = req.hostname;
  let urlPath = req.path;
  let redirectNeeded = false;

  if (host === 'local-share.com') {
    host = 'www.local-share.com';
    redirectNeeded = true;
  }
  if (urlPath.endsWith('/index.html')) {
    urlPath = urlPath.slice(0, -'index.html'.length);
    redirectNeeded = true;
  }
  if (!isHttps) {
    redirectNeeded = true;
  }

  if (redirectNeeded) {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(301, `https://${host}${urlPath}${query}`);
  }
  next();
});

// GitHub webhook: on push to main, pull and restart via pm2. Must be
// registered before express.json() so it can read the raw request body
// (needed to verify GitHub's HMAC signature).
const DEPLOY_WEBHOOK_SECRET = process.env.DEPLOY_WEBHOOK_SECRET;

app.post('/deploy-webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  if (!DEPLOY_WEBHOOK_SECRET) {
    console.error('Deploy webhook called but DEPLOY_WEBHOOK_SECRET is not configured');
    return res.status(503).end();
  }

  const signature = req.headers['x-hub-signature-256'];
  const expected = 'sha256=' + crypto.createHmac('sha256', DEPLOY_WEBHOOK_SECRET).update(req.body).digest('hex');
  const signatureBuf = Buffer.from(typeof signature === 'string' ? signature : '');
  const expectedBuf = Buffer.from(expected);
  if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
    return res.status(401).end();
  }

  if (req.headers['x-github-event'] === 'ping') {
    return res.status(200).end('pong');
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).end();
  }

  if (req.headers['x-github-event'] !== 'push' || payload.ref !== 'refs/heads/main') {
    return res.status(200).end('ignored');
  }

  res.status(202).end('deploying');

  const log = fs.openSync('/var/log/localshare-deploy.log', 'a');
  const child = spawn('/bin/sh', ['-c', 'git pull origin main && npm install --omit=dev && pm2 restart local-share.com'], {
    cwd: __dirname,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
});

// Cloudflare tells browsers to keep .css and .js files for 4 hours, while HTML
// is always fetched fresh. After a deploy, returning visitors would therefore
// get the new pages with the old stylesheet and script. Tagging those two URLs
// with a hash of the file's content makes a changed file a new URL.
const assetVersions = {};
for (const name of ['styles.css', 'client.js']) {
  const content = fs.readFileSync(path.join(publicPath, name));
  assetVersions[name] = crypto.createHash('sha1').update(content).digest('hex').slice(0, 10);
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const urlPath = req.path.endsWith('/') ? `${req.path}index.html` : req.path;
  if (!urlPath.endsWith('.html')) return next();

  const filePath = path.join(publicPath, urlPath);
  if (!filePath.startsWith(publicPath + path.sep)) return next();

  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return next();
    res.set('Cache-Control', 'public, max-age=0');
    res.type('html').send(html.replace(
      /(href|src)="\/(styles\.css|client\.js)"/g,
      (match, attr, name) => `${attr}="/${name}?v=${assetVersions[name]}"`
    ));
  });
});

// Middleware voor statische bestanden en JSON-parsing
app.use(express.static(publicPath));
app.use(express.json());

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new WebSocketServer({ server });

const clients = new Map();
const EXPIRATION_TIME = 72 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL = 30 * 1000;

const LINK_TTL = 60 * 60 * 1000;
const LINK_REQUEST_TTL = 2 * 60 * 1000;
const LINK_REQUESTS_PER_MINUTE_PER_DEVICE = 5;
const LINK_REQUESTS_PER_MINUTE_PER_NETWORK = 20;
const LINK_PRUNE_INTERVAL = 15 * 1000;
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

// Links let a device that landed on IPv4 see its household's IPv6 devices
// anyway. See network.js for why a link targets one device, not an IPv4
// address.
const linkStore = createLinkStore({
  linkTtl: LINK_TTL,
  requestTtl: LINK_REQUEST_TTL,
  maxRequestsPerTarget: 5,
  maxRequestsPerDevice: 3,
  maxRequestsPerSource: 20,
  maxRequests: 10000,
});

// Rate limits for link requests: per device (so neighbours sharing an IPv4
// address can't use up each other's allowance) and a looser one per source
// network (so minting new device tokens doesn't buy unlimited requests).
const recentLinkRequests = new Map(); // 'device:<token>' or 'network:<key>' -> [timestamps]

// Counts a request against every bucket, but only if all of them have room,
// so a refusal doesn't use up allowance in the others.
function allowLinkRequest(limits, now) {
  const buckets = limits.map(([key, limit]) => {
    const recent = (recentLinkRequests.get(key) || []).filter(t => t > now - 60 * 1000);
    return { key, limit, recent };
  });
  if (buckets.some(({ recent, limit }) => recent.length >= limit)) return false;
  buckets.forEach(({ key, recent }) => recentLinkRequests.set(key, [...recent, now]));
  return true;
}

// Two clients are only shown to each other (and allowed to signal each
// other) when they're on the same local network, or when one of them is a
// device linked to the other's network.
function canSee(a, b) {
  if (a === b) return true;
  if (a.networkKey && a.networkKey === b.networkKey) return true;
  const now = Date.now();
  return linkStore.isLinked(a.networkKey, b.linkToken, b.networkKey, now)
    || linkStore.isLinked(b.networkKey, a.linkToken, a.networkKey, now);
}

function sendLinkStatus(ws, status, message, expiresIn) {
  ws.send(JSON.stringify({ type: 'linkStatus', status, message, expiresIn }));
}

wss.on('connection', (ws, req) => {
  const clientId = Math.random().toString(36).substring(2, 15);
  const clientNetwork = parseNetwork(stats.extractIp(req));
  console.log('New connection, assigned ID:', clientId);

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    // A malformed message must never take the whole server down.
    try {
      handleClientMessage(message);
    } catch (error) {
      // Only the error type: a parse error's message quotes the raw input.
      console.error('Failed to handle message from', clientId, ':', error.name);
    }
  });

  function handleClientMessage(message) {
    const data = JSON.parse(message);
    if (!data || typeof data.type !== 'string') return;
    // Log only the message type, never its contents: those include file
    // names, IP addresses (in WebRTC signals), typed-in link addresses and
    // link tokens.
    console.log('Received', data.type.slice(0, 40), 'from', clientId);
    if (data.type === 'register') {
      console.log('Client registered - ID:', clientId);
      const linkToken = typeof data.linkToken === 'string' && LINK_TOKEN_PATTERN.test(data.linkToken)
        ? data.linkToken
        : null;
      clients.set(ws, {
        id: clientId,
        networkKey: clientNetwork?.key || null,
        networkFamily: clientNetwork?.family || null,
        linkToken,
        sharedFiles: [],
        sharedTexts: [],
      });
      if (ws.statsConnRowId == null) {
        ws.statsConnRowId = stats.recordConnection(req);
      }
      ws.send(JSON.stringify({ type: 'register', clientId }));
      broadcastUpdate();
    } else if (data.type === 'share') {
      const clientInfo = clients.get(ws);
      // Create a map of existing files by name for quick lookup
      const existingFilesMap = new Map(
        clientInfo.sharedFiles.map(file => [file.name, file])
      );
      // Merge new files, updating existing ones and adding new ones
      const updatedFiles = [];
      data.files.forEach(newFile => {
        if (existingFilesMap.has(newFile.name)) {
          // Update existing file's metadata (e.g., timestamp, size)
          const existingFile = existingFilesMap.get(newFile.name);
          updatedFiles.push({
            ...existingFile,
            size: newFile.size,
            timestamp: newFile.timestamp
          });
        } else {
          // Add new file
          updatedFiles.push(newFile);
          stats.recordFileShare(ws.statsConnRowId, newFile.size, newFile.timestamp);
        }
      });
      // Include existing files that weren't in the new data (to preserve them)
      existingFilesMap.forEach((existingFile, name) => {
        if (!data.files.some(newFile => newFile.name === name)) {
          updatedFiles.push(existingFile);
        }
      });
      clientInfo.sharedFiles = updatedFiles;
      console.log('Client updated shared files:', clientInfo.id, 'count:', clientInfo.sharedFiles.length);
      broadcastUpdate();
    } else if (data.type === 'stopSharing') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = [];
      console.log('Client stopped sharing:', clientInfo.id);
      broadcastUpdate();
    } else if (data.type === 'stopSharingFile') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = clientInfo.sharedFiles.filter(file => file.name !== data.name);
      console.log('Client stopped sharing file:', clientInfo.id);
      broadcastUpdate();
    } else if (data.type === 'shareText') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedTexts.push({
        id: data.id,
        label: data.label,
        length: data.length,
        timestamp: data.timestamp,
      });
      stats.recordTextShare(ws.statsConnRowId, data.length, data.timestamp);
      console.log('Client shared text:', clientInfo.id, 'id:', data.id);
      broadcastUpdate();
    } else if (data.type === 'stopSharingText') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedTexts = clientInfo.sharedTexts.filter(text => text.id !== data.id);
      console.log('Client stopped sharing text:', clientInfo.id, 'id:', data.id);
      broadcastUpdate();
    } else if (data.type === 'signal') {
      const targetClient = [...clients.entries()].find(
        ([_, info]) => info.id === data.targetId
      );
      const senderInfo = clients.get(ws);
      if (targetClient && senderInfo && canSee(senderInfo, targetClient[1])) {
        console.log('Sending signal from', clientId, 'to', data.targetId);
        targetClient[0].send(JSON.stringify({
          type: 'signal',
          fromId: clientId,
          kind: data.kind,
          signal: data.signal,
        }));
      } else {
        console.log('Target client not found or not on the same network:', data.targetId);
      }
    } else if (data.type === 'linkRequest') {
      handleLinkRequest(data);
    } else if (data.type === 'linkRespond') {
      const now = Date.now();
      if (!clients.has(ws) || !clientNetwork || typeof data.requestId !== 'string') return;
      const request = linkStore.takeRequest(data.requestId, clientNetwork.key, now);
      if (!request) return;
      if (data.allow === true) {
        linkStore.addLink(request.toKey, request.deviceToken, request.fromKey, now);
        console.log('Device link approved by', clientId);
      }
      broadcastUpdate();
    } else if (data.type === 'unlink') {
      const clientInfo = clients.get(ws);
      if (!clientInfo || typeof data.linkId !== 'string') return;
      if (linkStore.removeLink(data.linkId, clientInfo.networkKey, clientInfo.linkToken)) {
        console.log('Device link removed by', clientId);
        broadcastUpdate();
      }
    }
  }

  function handleLinkRequest(data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo || !clientNetwork || !clientInfo.linkToken) {
      return sendLinkStatus(ws, 'error', "Linking isn't available on this connection. Try reloading the page.");
    }
    if (clientNetwork.family !== 'IPv4') {
      return sendLinkStatus(ws, 'error', 'Enter your address on the other device instead.');
    }
    const target = typeof data.address === 'string' && data.address.length <= 100
      ? parseNetwork(data.address)
      : null;
    if (!target) {
      return sendLinkStatus(ws, 'error', "That doesn't look like an IPv6 address.");
    }
    if (target.family !== 'IPv6') {
      return sendLinkStatus(ws, 'error', 'Enter the IPv6 address shown on the other device.');
    }
    const now = Date.now();
    if (!allowLinkRequest([
      [`device:${clientInfo.linkToken}`, LINK_REQUESTS_PER_MINUTE_PER_DEVICE],
      [`network:${clientNetwork.key}`, LINK_REQUESTS_PER_MINUTE_PER_NETWORK],
    ], now)) {
      return sendLinkStatus(ws, 'error', 'Too many requests. Please wait a minute and try again.');
    }
    if (linkStore.isLinked(target.key, clientInfo.linkToken, clientNetwork.key, now)) {
      return sendLinkStatus(ws, 'error', 'Already linked with that network.');
    }
    const result = linkStore.addRequest({ deviceToken: clientInfo.linkToken, fromKey: clientNetwork.key, toKey: target.key }, now);
    if (result === 'source-limit') {
      return sendLinkStatus(ws, 'error', 'Too many requests are waiting for approval. Please try again in a few minutes.');
    }
    if (result === 'full') {
      return sendLinkStatus(ws, 'error', 'Linking is busy right now. Please try again later.');
    }
    // Same reply whether or not anyone is at that address, so the feature
    // can't be used to probe which addresses have LocalShare open.
    sendLinkStatus(ws, 'sent', describeNetwork(target.key).display, LINK_REQUEST_TTL);
    // Only devices on the target network need to hear about a new request.
    broadcastUpdate(recipient => recipient.networkKey === target.key);
  }

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      console.log('Client disconnected:', clientInfo.id);
      stats.markDisconnected(ws.statsConnRowId);
      clients.delete(ws);
      broadcastUpdate();
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error for client', clientId, ':', error);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      const clientInfo = clients.get(ws);
      console.log('Terminating unresponsive client:', clientInfo?.id);
      stats.markDisconnected(ws.statsConnRowId);
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

setInterval(() => {
  const now = Date.now();
  recentLinkRequests.forEach((timestamps, key) => {
    if (timestamps.every(t => t <= now - 60 * 1000)) recentLinkRequests.delete(key);
  });
  if (linkStore.prune(now)) broadcastUpdate();
}, LINK_PRUNE_INTERVAL);

// Sends every client (or only those matching `shouldSend`) its own view:
// the devices, files and texts it may see, plus its network and links.
function broadcastUpdate(shouldSend = () => true) {
  const now = Date.now();
  const devices = [...clients.values()];
  devices.forEach(client => {
    client.sharedFiles = client.sharedFiles.filter(file => {
      const age = now - file.timestamp;
      return age < EXPIRATION_TIME;
    });
    client.sharedTexts = client.sharedTexts.filter(text => {
      const age = now - text.timestamp;
      return age < EXPIRATION_TIME;
    });
  });
  console.log('Connected clients:', [...clients.keys()].map(ws => clients.get(ws).id));
  // Each client only sees devices/files/text from its own local network,
  // so the payload is computed per recipient rather than broadcast as-is.
  clients.forEach((recipient, clientWs) => {
    if (!shouldSend(recipient)) return;
    const peers = devices.filter(client => canSee(client, recipient));
    const deviceCount = peers.length;
    const sharedFiles = peers.flatMap(client => client.sharedFiles.map(file => ({
      name: file.name,
      size: file.size,
      ownerId: client.id,
    })));
    const sharedTexts = peers.flatMap(client => client.sharedTexts.map(text => ({
      id: text.id,
      label: text.label,
      length: text.length,
      ownerId: client.id,
    })));
    // Expiry is sent as time remaining rather than a timestamp, so the
    // client's countdown doesn't depend on its clock matching ours.
    // A link's other side is shown as the network on the far end: the IPv6
    // network for the linked device, or the address the device asked from
    // for devices on that network (never its token, which stays secret, and
    // never where the device is now). A linked device that has moved to
    // another network doesn't see its link, since it no longer applies there.
    const key = recipient.networkKey;
    const network = key ? describeNetwork(key) : null;
    const links = linkStore.linksFor(key, recipient.linkToken, now)
      .filter(link => link.networkKey === key || link.deviceKey === key)
      .map(link => ({
        id: link.id,
        display: link.networkKey === key
          ? `a device at ${describeNetwork(link.deviceKey).display}`
          : describeNetwork(link.networkKey).display,
        expiresIn: link.expiresAt - now,
      }));
    const linkRequests = key ? linkStore.requestsFor(key, now).map(request => ({
      id: request.id,
      from: describeNetwork(request.fromKey).display,
      expiresIn: request.expiresAt - now,
    })) : [];
    try {
      clientWs.send(JSON.stringify({
        type: 'update',
        deviceCount,
        sharedFiles,
        sharedTexts,
        network,
        links,
        linkRequests,
      }));
    } catch (error) {
      console.error('Failed to send update to client:', recipient.id, error);
      clients.delete(clientWs);
    }
  });
}

// Nodemailer configuratie met omgevingsvariabelen
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

diskAlert.start({
  sendMail: (options, callback) => transporter.sendMail(options, callback),
  from: process.env.EMAIL_USER,
  to: process.env.NOTIFY_EMAIL
});

// POST-route voor suggesties
app.post('/submit-suggestion', (req, res) => {
  const { suggestion } = req.body;

  if (!suggestion) {
    return res.status(400).json({ error: 'Suggestion is required' });
  }

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: '[LocalShare] User Suggestion',
    text: suggestion
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Error sending email:', error);
      return res.status(500).json({ error: 'Failed to send suggestion' });
    }
    console.log('Email sent:', info.response);
    res.status(200).json({ message: 'Suggestion sent successfully' });
  });
});
