const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');

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
  const child = spawn('/bin/sh', ['-c', 'git pull origin main && pm2 restart local-share.com'], {
    cwd: __dirname,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
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

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 15);
  console.log('New connection, assigned ID:', clientId);

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    console.log('Received message from', clientId, ':', data);
    if (data.type === 'register') {
      console.log('Client registered - ID:', clientId);
      clients.set(ws, { id: clientId, sharedFiles: [], sharedTexts: [] });
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
        }
      });
      // Include existing files that weren't in the new data (to preserve them)
      existingFilesMap.forEach((existingFile, name) => {
        if (!data.files.some(newFile => newFile.name === name)) {
          updatedFiles.push(existingFile);
        }
      });
      clientInfo.sharedFiles = updatedFiles;
      console.log('Client updated shared files:', clientInfo.id, 'Files:', clientInfo.sharedFiles);
      broadcastUpdate();
    } else if (data.type === 'stopSharing') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = [];
      console.log('Client stopped sharing:', clientInfo.id);
      broadcastUpdate();
    } else if (data.type === 'stopSharingFile') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = clientInfo.sharedFiles.filter(file => file.name !== data.name);
      console.log('Client stopped sharing file:', clientInfo.id, 'name:', data.name);
      broadcastUpdate();
    } else if (data.type === 'shareText') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedTexts.push({
        id: data.id,
        label: data.label,
        length: data.length,
        timestamp: data.timestamp,
      });
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
      if (targetClient) {
        console.log('Sending signal from', clientId, 'to', data.targetId);
        targetClient[0].send(JSON.stringify({
          type: 'signal',
          fromId: clientId,
          kind: data.kind,
          signal: data.signal,
        }));
      } else {
        console.log('Target client not found:', data.targetId);
      }
    }
  });

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      console.log('Client disconnected:', clientInfo.id);
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
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

function broadcastUpdate() {
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
  const deviceCount = devices.length;
  const sharedFiles = devices.flatMap(client => client.sharedFiles.map(file => ({
    name: file.name,
    size: file.size,
    ownerId: client.id,
  })));
  const sharedTexts = devices.flatMap(client => client.sharedTexts.map(text => ({
    id: text.id,
    label: text.label,
    length: text.length,
    ownerId: client.id,
  })));
  console.log('Broadcasting to all - Devices:', deviceCount, 'Files:', sharedFiles, 'Texts:', sharedTexts);
  console.log('Connected clients:', [...clients.keys()].map(ws => clients.get(ws).id));
  clients.forEach((_, clientWs) => {
    try {
      clientWs.send(JSON.stringify({
        type: 'update',
        deviceCount,
        sharedFiles,
        sharedTexts,
      }));
    } catch (error) {
      console.error('Failed to send update to client:', clients.get(clientWs)?.id, error);
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
