const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// WebSocket server with path
const wss = new WebSocketServer({ server, path: '/localshare/public/ws' }); // Match client path

const clients = new Map();

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 15);

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    if (data.type === 'register') {
      const subnet = data.ip.split('.').slice(0, 3).join('.');
      clients.set(ws, { id: clientId, ip: data.ip, subnet, sharedFiles: [] });
      broadcastUpdate(subnet);
    } else if (data.type === 'share') {
      const clientInfo = clients.get(ws);
      clientInfo.sharedFiles = data.files;
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
  const devices = [...clients.values()].filter(client => client.subnet === subnet);
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