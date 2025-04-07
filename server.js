const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const compression = require('compression');

const app = express();
const port = process.env.PORT || 10000;

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
  console.error(`Error: Public directory not found at ${publicPath}`);
  process.exit(1);
}

app.use(compression());
app.use(express.static(publicPath, { maxAge: '1d' }));
app.use(express.json());

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new WebSocketServer({ server });

const clients = new Map(); // Map<ws, { id, networkId, sharedFiles }>
const networkSessions = new Map(); // Map<ip, networkId>
const EXPIRATION_TIME = 72 * 60 * 60 * 1000;
const SESSION_WINDOW = 5 * 60 * 1000; // 5 minuten window om apparaten te groeperen

wss.on('connection', (ws, req) => {
  const clientId = Math.random().toString(36).substring(2, 15);
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || ws._socket.remoteAddress;
  console.log('New connection from IP:', clientIp, 'Assigned ID:', clientId);

  // Genereer of haal netwerk-ID op basis van IP en tijd
  let networkId;
  if (networkSessions.has(clientIp)) {
    networkId = networkSessions.get(clientIp);
  } else {
    networkId = `net-${Math.random().toString(36).substring(2, 10)}-${Date.now()}`;
    networkSessions.set(clientIp, networkId);
    // Verwijder sessie na SESSION_WINDOW om nieuwe netwerken mogelijk te maken
    setTimeout(() => networkSessions.delete(clientIp), SESSION_WINDOW);
  }

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    console.log('Received message from', clientId, ':', data);
    if (data.type === 'register') {
      console.log('Client registered - ID:', clientId, 'Network:', networkId);
      clients.set(ws, { id: clientId, networkId, sharedFiles: [] });
      ws.send(JSON.stringify({ type: 'register', clientId }));
      broadcastUpdate(networkId);
    } else if (data.type === 'share') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = data.files;
      console.log('Client shared files:', clientInfo.id, 'Files:', data.files);
      broadcastUpdate(clientInfo.networkId);
    } else if (data.type === 'stopSharing') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = [];
      console.log('Client stopped sharing:', clientInfo.id);
      broadcastUpdate(clientInfo.networkId);
    } else if (data.type === 'signal') {
      const targetClient = [...clients.entries()].find(
        ([_, info]) => info.id === data.targetId && info.networkId === clients.get(ws).networkId
      );
      if (targetClient) {
        console.log('Sending signal from', clientId, 'to', data.targetId);
        targetClient[0].send(JSON.stringify({
          type: 'signal',
          fromId: clientId,
          signal: data.signal,
        }));
      } else {
        console.log('Target client not found or not in same network:', data.targetId);
      }
    }
  });

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      console.log('Client disconnected:', clientInfo.id);
      clients.delete(ws);
      broadcastUpdate(clientInfo.networkId);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error for client', clientId, ':', error);
  });
});

function broadcastUpdate(networkId) {
  const now = Date.now();
  const networkClients = [...clients.entries()].filter(
    ([_, info]) => info.networkId === networkId
  );
  const devices = networkClients.map(([_, info]) => info);
  devices.forEach(client => {
    client.sharedFiles = client.sharedFiles.filter(file => {
      const age = now - file.timestamp;
      return age < EXPIRATION_TIME;
    });
  });
  const deviceCount = devices.length;
  const sharedFiles = devices.flatMap(client => client.sharedFiles.map(file => ({
    name: file.name,
    size: file.size,
    ownerId: client.id,
  })));
  console.log(`Broadcasting to network ${networkId} - Devices: ${deviceCount}, Files:`, sharedFiles);
  networkClients.forEach(([clientWs, _]) => {
    try {
      clientWs.send(JSON.stringify({
        type: 'update',
        deviceCount,
        sharedFiles,
      }));
    } catch (error) {
      console.error('Failed to send update to client:', clients.get(clientWs)?.id, error);
    }
  });
}

// Nodemailer configuratie blijft ongewijzigd
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.post('/submit-suggestion', (req, res) => {
  const { suggestion } = req.body;
  if (!suggestion) return res.status(400).json({ error: 'Suggestion is required' });
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: 'niels.onderbeke@gmail.com',
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
