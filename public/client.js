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

function requestFile(ownerId, fileName) {
  console.log('requestFile called - ownerId:', ownerId, 'fileName:', fileName);
  targetId = ownerId;
  setupWebRTC(() => {
    console.log('DataChannel opened, sending request for:', fileName);
    dataChannel.send(JSON.stringify({ type: 'request', fileName }));
  });
}

function requestFile(ownerId, fileName) {
  console.log('requestFile called - ownerId:', ownerId, 'fileName:', fileName);
  targetId = ownerId;
  setupWebRTC(() => {
    console.log('DataChannel opened, sending request for:', fileName);
    try {
      dataChannel.send(JSON.stringify({ type: 'request', fileName }));
    } catch (error) {
      console.error('Error sending request:', error);
    }
  });
}

function setupWebRTC(onOpenCallback) {
  console.log('Setting up WebRTC connection');
  try {
    peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    console.log('RTCPeerConnection created');
  } catch (error) {
    console.error('Error creating RTCPeerConnection:', error);
    return;
  }
  dataChannel = peerConnection.createDataChannel('fileTransfer');

  dataChannel.onopen = () => {
    console.log('DataChannel opened');
    document.getElementById('status').textContent = 'Connection established!';
    if (onOpenCallback) onOpenCallback();
  };
  dataChannel.onmessage = handleDataChannelMessage;
  dataChannel.onerror = (error) => console.error('DataChannel error:', error);
  dataChannel.onclose = () => console.log('DataChannel closed');

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      console.log('ICE candidate found:', e.candidate.candidate);
      try {
        ws.send(JSON.stringify({
          type: 'signal',
          targetId,
          signal: { candidate: e.candidate },
        }));
        console.log('ICE candidate sent to:', targetId);
      } catch (error) {
        console.error('Error sending ICE candidate:', error);
      }
    } else {
      console.log('ICE candidate gathering complete');
    }
  };
  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
  };
  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE connection state:', peerConnection.iceConnectionState);
  };

  console.log('Creating offer');
  peerConnection.createOffer()
    .then(offer => {
      console.log('Offer created:', offer.sdp.substring(0, 100) + '...');
      return peerConnection.setLocalDescription(offer);
    })
    .then(() => {
      console.log('Local description set, sending offer to target:', targetId);
      ws.send(JSON.stringify({
        type: 'signal',
        targetId,
        signal: peerConnection.localDescription,
      }));
    })
    .catch(error => {
      console.error('WebRTC setup error:', error);
    });
}

function handleSignal(data) {
  console.log('Received signal from:', data.fromId, 'for target:', data.targetId);
  if (!peerConnection) {
    console.log('Creating new RTCPeerConnection for incoming signal');
    peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerConnection.ondatachannel = (e) => {
      dataChannel = e.channel;
      dataChannel.onopen = () => {
        console.log('Incoming DataChannel opened');
        document.getElementById('status').textContent = 'Connection established!';
      };
      dataChannel.onmessage = handleDataChannelMessage;
      dataChannel.onerror = (error) => console.error('Incoming DataChannel error:', error);
    };
  }

  if (data.signal.type === 'offer') {
    console.log('Handling offer');
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => peerConnection.createAnswer())
      .then(answer => peerConnection.setLocalDescription(answer))
      .then(() => {
        console.log('Sending answer to:', data.fromId);
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: data.fromId,
          signal: peerConnection.localDescription,
        }));
      })
      .catch(error => console.error('Error handling offer:', error));
  } else if (data.signal.candidate) {
    console.log('Adding ICE candidate');
    peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate))
      .catch(error => console.error('Error adding ICE candidate:', error));
  }
}

window.onload = registerDevice;