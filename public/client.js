let ws;
let peerConnection;
let dataChannel;
let myId;
let targetId;
let sharedFilesMap = new Map();

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const hostname = window.location.hostname;
const serverUrl = `${protocol}//${hostname}`;

async function getLocalIP() {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('dummy');
    let localIP;

    pc.onicecandidate = (e) => {
      if (e.candidate && e.candidate.candidate.includes('typ host')) {
        localIP = e.candidate.address;
        pc.close();
        resolve(localIP);
      }
    };

    pc.createOffer().then(offer => pc.setLocalDescription(offer));
    setTimeout(() => {
      if (!localIP) {
        pc.close();
        resolve(null);
      }
    }, 5000);
  });
}

async function registerDevice() {
  document.getElementById('deviceCount').textContent = 'Connecting...';

  const ip = await getLocalIP();
  if (!ip) {
    document.getElementById('deviceCount').textContent = 'Error: Could not detect local IP. Check network or refresh.';
    return;
  }

  console.log(`Attempting to connect to WebSocket at: ${serverUrl}`);
  ws = new WebSocket(serverUrl);

  ws.onopen = () => {
    console.log('WebSocket connected successfully');
    ws.send(JSON.stringify({ type: 'register', ip }));
    updateDeviceCount(1);
    checkFolderSupport();
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    document.getElementById('deviceCount').textContent = 'Error: Could not connect to server. Check server status or refresh.';
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed:', event);
    if (document.getElementById('deviceCount').textContent === 'Connecting...') {
      document.getElementById('deviceCount').textContent = 'Error: Connection lost. Refresh to retry.';
    }
  };

  ws.onmessage = handleMessage;
}

function shareFiles() {
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  const files = Array.from(fileInput.files).concat(Array.from(folderInput.files || [])); // Combine both inputs
  files.forEach(file => sharedFilesMap.set(file.name, file));
  const fileMetadata = files.map(file => ({
    name: file.name,
    size: file.size,
    timestamp: Date.now()
  }));
  if (files.length > 0) {
    ws.send(JSON.stringify({ type: 'share', files: fileMetadata }));
    document.getElementById('status').textContent = 'Files shared!';
  }
}

function checkFolderSupport() {
  const folderInput = document.getElementById('folderInput');
  if (!('webkitdirectory' in folderInput)) {
    document.getElementById('fallbackMessage').style.display = 'block';
    folderInput.style.display = 'none'; // Hide folder input if unsupported
  }
}

function handleMessage(event) {
  const data = JSON.parse(event.data);

  if (data.type === 'update') {
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
  files.forEach(file => {
    if (file.ownerId !== myId) {
      const li = document.createElement('li');
      const sizeInKB = (file.size / 1024).toFixed(2);
      li.innerHTML = `<span>${file.name} (${sizeInKB} KB)</span>`;
      const downloadBtn = document.createElement('button');
      downloadBtn.textContent = 'Download';
      downloadBtn.onclick = () => requestFile(file.ownerId, file.name);
      li.appendChild(downloadBtn);
      list.appendChild(li);
    }
  });
}

function shareFiles() {
  const shareInput = document.getElementById('shareInput');
  const files = Array.from(shareInput.files);
  files.forEach(file => sharedFilesMap.set(file.name, file));
  const fileMetadata = files.map(file => ({
    name: file.name,
    size: file.size,
    timestamp: Date.now() // Add timestamp for expiration
  }));
  ws.send(JSON.stringify({ type: 'share', files: fileMetadata }));
  document.getElementById('status').textContent = 'Files shared!';
}

function stopSharing() {
  sharedFilesMap.clear();
  ws.send(JSON.stringify({ type: 'stopSharing' }));
  document.getElementById('status').textContent = 'File sharing stopped.';
}

function requestFile(ownerId, fileName) {
  targetId = ownerId;
  setupWebRTC(() => {
    dataChannel.send(JSON.stringify({ type: 'request', fileName }));
  });
}

function setupWebRTC(onOpenCallback) {
  peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  dataChannel = peerConnection.createDataChannel('fileTransfer');

  dataChannel.onopen = () => {
    document.getElementById('status').textContent = 'Connection established!';
    if (onOpenCallback) onOpenCallback();
  };
  dataChannel.onmessage = handleDataChannelMessage;

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({
        type: 'signal',
        targetId,
        signal: { candidate: e.candidate },
      }));
    }
  };

  peerConnection.createOffer()
    .then(offer => peerConnection.setLocalDescription(offer))
    .then(() => {
      ws.send(JSON.stringify({
        type: 'signal',
        targetId,
        signal: peerConnection.localDescription,
      }));
    });
}

async function handleSignal(data) {
  if (!peerConnection) {
    peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerConnection.ondatachannel = (e) => {
      dataChannel = e.channel;
      dataChannel.onopen = () => document.getElementById('status').textContent = 'Connection established!';
      dataChannel.onmessage = handleDataChannelMessage;
    };
  }

  if (data.signal.type === 'offer') {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    ws.send(JSON.stringify({
      type: 'signal',
      targetId: data.fromId,
      signal: peerConnection.localDescription,
    }));
  } else if (data.signal.candidate) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
  }
}

function handleDataChannelMessage(e) {
  const message = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
  if (message.type === 'request') {
    const file = sharedFilesMap.get(message.fileName);
    if (file) {
      sendFileWithProgress(file);
    }
  } else {
    receiveFileWithProgress(e.data);
  }
}

function sendFileWithProgress(file) {
  const chunkSize = 16384;
  file.arrayBuffer().then(buffer => {
    const totalSize = buffer.byteLength;
    let offset = 0;
    const progressBar = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');

    progressBar.style.display = 'block';
    document.getElementById('status').textContent = `Sending ${file.name}...`;

    function sendNextChunk() {
      if (offset < totalSize) {
        const chunk = buffer.slice(offset, offset + chunkSize);
        dataChannel.send(chunk);
        offset += chunkSize;
        const progress = (offset / totalSize) * 100;
        progressFill.style.width = `${progress}%`;
        setTimeout(sendNextChunk, 10);
      } else {
        progressBar.style.display = 'none';
        document.getElementById('status').textContent = `Sent ${file.name}`;
      }
    }
    sendNextChunk();
  });
}

function receiveFileWithProgress(data) {
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = [...sharedFilesMap.keys()].find(name => name === (targetId && sharedFilesMap.get(name)?.name)) || 'downloaded_file';
  a.click();
  document.getElementById('status').textContent = 'File downloaded!';
  document.getElementById('progress').style.display = 'none';
}

window.onload = registerDevice;