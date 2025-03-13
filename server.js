const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
  console.error(`Error: Public directory not found at ${publicPath}`);
  process.exit(1);
}

app.use(express.static(publicPath));

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new WebSocketServer({ server });

const clients = new Map();
const EXPIRATION_TIME = 72 * 60 * 60 * 1000; // 72 hours in milliseconds

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 15);

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    if (data.type === 'register') {
      const subnet = data.ip.split('.').slice(0, 3).join('.');
      console.log('Client registered - IP:', data.ip, 'Subnet:', subnet);
      clients.set(ws, { id: clientId, ip: data.ip, subnet, sharedFiles: [] });
      ws.send(JSON.stringify({ type: 'register', clientId }));
      broadcastUpdate(subnet);
    } else if (data.type === 'share') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = data.files; // Files now include timestamps
      broadcastUpdate(clientInfo.subnet);
    } else if (data.type === 'stopSharing') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = []; // Clear shared files
      broadcastUpdate(clientInfo.subnet);
    } else if (data.type === 'signal') {
      const targetClient = [...clients.entries()].find(
        ([_, info]) => info.id === data.targetId
      );
      if (targetClient) {
        targetClient[0].send(JSON.stringify({
          type: 'signal',
          fromId: clientId,
          signal: data.signal,
        }));
      }
    }
  });

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      const subnet = clientInfo.subnet;
      clients.delete(ws);
      broadcastUpdate(subnet);
    }
  });
});

function broadcastUpdate(subnet) {
  const now = Date.now();
  const devices = [...clients.values()].filter(client => client.subnet === subnet);

  // Filter out expired files
  devices.forEach(client => {
    client.sharedFiles = client.sharedFiles.filter(file => {
      const age = now - file.timestamp;
      return age < EXPIRATION_TIME; // Keep files younger than 72 hours
    });
  });

  const deviceCount = devices.length;
  const sharedFiles = devices.flatMap(client => client.sharedFiles.map(file => ({
    name: file.name,
    size: file.size,
    ownerId: client.id,
  })));

  clients.forEach((info, clientWs) => {
    if (info.subnet === subnet) {
      clientWs.send(JSON.stringify({
        type: 'update',
        deviceCount,
        sharedFiles,
      }));
    }
  });
}