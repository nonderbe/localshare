const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 10000;

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
  console.error(`Error: Public directory not found at ${publicPath}`);
  process.exit(1);
}

// Middleware voor statische bestanden en JSON-parsing
app.use(express.static(publicPath));
app.use(express.json());

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new WebSocketServer({ server });

const clients = new Map();
const EXPIRATION_TIME = 72 * 60 * 60 * 1000;

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 15);
  console.log('New connection, assigned ID:', clientId);

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    console.log('Received message from', clientId, ':', data);
    if (data.type === 'register') {
      console.log('Client registered - ID:', clientId);
      clients.set(ws, { id: clientId, sharedFiles: [] });
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
    } else if (data.type === 'signal') {
      const targetClient = [...clients.entries()].find(
        ([_, info]) => info.id === data.targetId
      );
      if (targetClient) {
        console.log('Sending signal from', clientId, 'to', data.targetId);
        targetClient[0].send(JSON.stringify({
          type: 'signal',
          fromId: clientId,
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

function broadcastUpdate() {
  const now = Date.now();
  const devices = [...clients.values()];
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
  console.log('Broadcasting to all - Devices:', deviceCount, 'Files:', sharedFiles);
  console.log('Connected clients:', [...clients.keys()].map(ws => clients.get(ws).id));
  clients.forEach((_, clientWs) => {
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
