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
const EXPIRATION_TIME = 72 * 60 * 60 * 1000;

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 15);

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    console.log('Received message:', data);
    if (data.type === 'register') {
      console.log('Client registered - ID:', clientId);
      clients.set(ws, { id: clientId, sharedFiles: [] });
      ws.send(JSON.stringify({ type: 'register', clientId }));
      broadcastUpdate();
    } else if (data.type === 'share') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = data.files;
      console.log('Client shared files:', clientInfo.id, 'Files:', data.files);
      broadcastUpdate();
    } else if (data.type === 'stopSharing') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = [];
      console.log('Client stopped sharing:', clientInfo.id);
      broadcastUpdate();
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
      console.log('Client disconnected:', clientInfo.id);
      clients.delete(ws);
      broadcastUpdate();
    }
  });
});

function broadcastUpdate() {
  const now = Date.now();
  const devices = [...clients.values()];
  devices.forEach(client => {
    client.sharedFiles = client.sharedFiles.filter=file => {
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
  console.log('Broadcasting to all - Devices:', deviceCount, 'Files:', sharedFiles);
  clients.forEach((_, clientWs) => {
    clientWs.send(JSON.stringify({
      type: 'update',
      deviceCount,
      sharedFiles,
    }));
  });
}