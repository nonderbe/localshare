console.log('client.js loaded successfully');

let ws;
let peerConnection;
let dataChannel;
let myId;
let targetId;
let sharedFilesMap = new Map();

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const hostname = window.location.hostname;
const serverUrl = `${protocol}//${hostname}`;

async function registerDevice() {
  document.getElementById('deviceCount').textContent = 'Connecting...';

  console.log(`Attempting to connect to WebSocket at: ${serverUrl}`);
  ws = new WebSocket(serverUrl);

  ws.onopen = () => {
    console.log('WebSocket connected successfully');
    ws.send(JSON.stringify({ type: 'register' })); // Geen IP meer nodig
    updateDeviceCount(1);
    checkFolderSupport();
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    document.getElementById('deviceCount').textContent = 'Error: Could not connect to server.';
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed:', event);
    if (document.getElementById('deviceCount').textContent === 'Connecting...') {
      document.getElementById('deviceCount').textContent = 'Error: Connection lost.';
    }
  };

  ws.onmessage = handleMessage;
}

function checkFolderSupport() {
  const folderInput = document.getElementById('folderInput');
  if (!('webkitdirectory' in folderInput)) {
    document.getElementById('fallbackMessage').style.display = 'block';
    folderInput.style.display = 'none';
  }
}

function handleMessage(event) {
  const data = JSON.parse(event.data);
  console.log('Received from server:', data);
  if (data.type === 'register') {
    myId = data.clientId;
  } else if (data.type === 'update') {
    console.log('Processing update - Device count:', data.deviceCount, 'Files:', data.sharedFiles);
    updateDeviceCount(data.deviceCount);
    updateFileList(data.sharedFiles);
  } else if (data.type === 'signal') {
    handleSignal(data);
  }
}

function updateDeviceCount(count) {
  document.getElementById('deviceCount').textContent = 
    `${count} device${count === 1 ? '' : 's'} connected`;
}

function updateFileList(files) {
  const list = document.getElementById('fileList');
  list.innerHTML = '';
  console.log('Files received for list:', files);
  files.forEach(file => {
    console.log('Processing file:', file.name, 'Owner:', file.ownerId, 'My ID:', myId);
    const li = document.createElement('li');
    const sizeInKB = (file.size / 1024).toFixed(2);
    li.innerHTML = `<span>${file.name} (${sizeInKB} KB)</span>`;
    if (file.ownerId !== myId) {
      const downloadBtn = document.createElement('button');
      downloadBtn.textContent = 'Download';
      downloadBtn.onclick = () => requestFile(file.ownerId, file.name);
      li.appendChild(downloadBtn);
    } else {
      li.innerHTML += ' (Yours)';
    }
    list.appendChild(li);
  });
}

function shareFiles() {
  console.log('shareFiles() called');
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  console.log('Raw fileInput.files:', fileInput.files);
  console.log('Raw folderInput.files:', folderInput.files);
  const files = Array.from(fileInput.files).concat(Array.from(folderInput.files || []));
  console.log('Combined files:', files);
  files.forEach(file => sharedFilesMap.set(file.name, file));
  const fileMetadata = files.map(file => ({
    name: file.name,
    size: file.size,
    timestamp: Date.now()
  }));
  console.log('File metadata to send:', fileMetadata);
  if (files.length > 0) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'share', files: fileMetadata }));
      document.getElementById('status').textContent = 'Files shared!';
    } else {
      console.error('WebSocket not open, cannot share files');
      document.getElementById('status').textContent = 'Error: Cannot share - connection lost.';
    }
  } else {
    console.log('No files selected to share');
  }
}

// ... (rest of the code unchanged: stopSharing, requestFile, setupWebRTC, etc.)

window.onload = registerDevice;