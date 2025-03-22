// Globale variabelen
const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:109.236.133.105:3478', username: 'test', credential: 'test123' }
];
let ws;
let myId;
let peerConnection;
let dataChannel;
let targetId;
let expectedFileName;
let totalSize = 0;
let receivedChunks = [];
let pendingCandidates = [];
const sharedFilesMap = new Map();

function logToUI(message) {
  console.log(message);
  const logContainer = document.getElementById('logContainer');
  const logEntry = document.createElement('div');
  logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContainer.appendChild(logEntry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

logToUI('client.js loaded successfully');

function connectWebSocket() {
  const wsUrl = 'wss://localshare-cj69.onrender.com';
  logToUI(`Attempting to connect to WebSocket at: ${wsUrl}`);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => logToUI('WebSocket connected successfully');
  ws.onclose = (event) => logToUI(`WebSocket connection closed - Code: ${event.code}, Reason: ${event.reason}`);
  ws.onerror = (error) => logToUI('WebSocket error: ' + error);
  ws.onmessage = handleMessage;
}

function handleMessage(event) {
  const data = JSON.parse(event.data);
  logToUI(`Received from server: ${JSON.stringify(data)}`);
  switch (data.type) {
    case 'register':
      myId = data.clientId;
      logToUI(`Registered with clientId: ${myId}`);
      break;
    case 'update':
      updateFileList(data.deviceCount, data.sharedFiles);
      break;
    case 'signal':
      handleSignal(data);
      break;
  }
}

function updateFileList(deviceCount, files) {
  logToUI(`Processing update - Device count: ${deviceCount} Files: ${JSON.stringify(files)}`);
  const fileList = document.getElementById('fileList');
  fileList.innerHTML = '';
  logToUI(`Files received for list: ${JSON.stringify(files)}`);
  files.forEach(file => {
    logToUI(`Processing file: ${file.name} Owner: ${file.ownerId} My ID: ${myId}`);
    const li = document.createElement('li');
    li.textContent = `${file.name} (${file.size} bytes) - Owner: ${file.ownerId}`;
    if (file.ownerId !== myId) {
      const downloadButton = document.createElement('button');
      downloadButton.textContent = 'Download';
      downloadButton.onclick = () => requestFile(file.ownerId, file.name);
      li.appendChild(downloadButton);
    }
    fileList.appendChild(li);
  });
}

function shareFiles() {
  logToUI('shareFiles() called');
  if (!myId) {
    logToUI('Cannot share files: not yet registered with server');
    document.getElementById('status').textContent = 'Error: Not registered yet, please wait.';
    return;
  }
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  logToUI(`Raw fileInput.files: ${JSON.stringify(fileInput.files)}`);
  logToUI(`Raw folderInput.files: ${JSON.stringify(folderInput.files)}`);
  const files = Array.from(fileInput.files).concat(Array.from(folderInput.files || []));
  logToUI(`Combined files: ${JSON.stringify(files)}`);
  files.forEach(file => {
    sharedFilesMap.set(file.name, file);
    logToUI(`Added to sharedFilesMap: ${file.name}, size: ${file.size}`);
  });
  const fileMetadata = files.map(file => ({
    name: file.name,
    size: file.size,
    timestamp: Date.now()
  }));
  logToUI(`File metadata to send: ${JSON.stringify(fileMetadata)}`);
  if (files.length > 0) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'share', files: fileMetadata }));
      logToUI('Share request sent to server');
      document.getElementById('status').textContent = 'Files shared!';
    } else {
      logToUI('WebSocket not open, cannot share files');
      document.getElementById('status').textContent = 'Error: Cannot share - connection lost.';
    }
  } else {
    logToUI('No files selected to share');
  }
}

function requestFile(ownerId, fileName) {
  logToUI(`requestFile called - ownerId: ${ownerId} fileName: ${fileName}`);
  targetId = ownerId;

  logToUI('Setting up WebRTC connection');
  try {
    logToUI(`iceServers config: ${JSON.stringify(iceServers)}`);
    peerConnection = new RTCPeerConnection({ iceServers });
    logToUI('RTCPeerConnection created');
  } catch (error) {
    logToUI(`Error creating RTCPeerConnection: ${error.message || error}`);
    return;
  }

  dataChannel = peerConnection.createDataChannel('fileTransfer');
  logToUI('DataChannel created');
  dataChannel.onopen = () => {
    logToUI('DataChannel opened');
    const requestMessage = JSON.stringify({ type: 'request', fileName });
    logToUI(`Sending file request: ${requestMessage}`);
    dataChannel.send(requestMessage);
    expectedFileName = fileName;
  };
  dataChannel.onclose = () => logToUI('DataChannel closed');
  dataChannel.onmessage = handleDataChannelMessage;

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      logToUI(`ICE candidate found: ${event.candidate.candidate}`);
      ws.send(JSON.stringify({ type: 'signal', targetId: ownerId, signal: event.candidate }));
    }
  };

  logToUI('Creating offer');
  peerConnection.createOffer()
    .then((offer) => {
      logToUI(`Offer created: ${offer.sdp}`);
      return peerConnection.setLocalDescription(offer);
    })
    .then(() => {
      logToUI(`Local description set, sending offer to target: ${ownerId}`);
      ws.send(JSON.stringify({ type: 'signal', targetId: ownerId, signal: peerConnection.localDescription }));
    })
    .catch((error) => logToUI('Error creating offer: ' + error));
}

function handleSignal(data) {
  const { fromId, signal } = data;
  logToUI(`Received signal from: ${fromId} for target: ${myId}`);
  
  if (signal.type === 'offer') {
    if (peerConnection && peerConnection.signalingState !== 'closed') {
      logToUI('Existing peerConnection still active, ignoring new offer');
      return;
    }
    logToUI('Creating new RTCPeerConnection for incoming offer');
    peerConnection = new RTCPeerConnection({ iceServers });
    peerConnection.ondatachannel = (event) => {
      logToUI('DataChannel received from peer');
      dataChannel = event.channel;
      dataChannel.onopen = () => logToUI('DataChannel opened');
      dataChannel.onclose = () => logToUI('DataChannel closed');
      dataChannel.onmessage = handleDataChannelMessage;
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        logToUI(`ICE candidate found: ${event.candidate.candidate}`);
        ws.send(JSON.stringify({ type: 'signal', targetId: fromId, signal: event.candidate }));
      }
    };

    peerConnection.setRemoteDescription(new RTCSessionDescription(signal))
      .then(() => {
        if (pendingCandidates.length > 0) {
          logToUI(`Adding ${pendingCandidates.length} pending ICE candidates`);
          pendingCandidates.forEach(candidate => {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
              .catch(error => logToUI('Error adding pending ICE candidate: ' + error));
          });
          pendingCandidates = [];
        }
        return peerConnection.createAnswer();
      })
      .then((answer) => peerConnection.setLocalDescription(answer))
      .then(() => {
        logToUI('Sending answer to: ' + fromId);
        ws.send(JSON.stringify({ type: 'signal', targetId: fromId, signal: peerConnection.localDescription }));
      })
      .catch((error) => logToUI('Error handling offer: ' + error));
  } else if (signal.type === 'answer') {
    if (peerConnection) {
      logToUI('Setting remote description with answer from: ' + fromId);
      peerConnection.setRemoteDescription(new RTCSessionDescription(signal))
        .then(() => {
          if (pendingCandidates.length > 0) {
            logToUI(`Adding ${pendingCandidates.length} pending ICE candidates`);
            pendingCandidates.forEach(candidate => {
              peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(error => logToUI('Error adding pending ICE candidate: ' + error));
            });
            pendingCandidates = [];
          }
        })
        .catch((error) => logToUI('Error setting remote description: ' + error));
    } else {
      logToUI('No peerConnection exists to handle answer');
    }
  } else if (signal.candidate) {
    if (peerConnection) {
      logToUI(`Received ICE candidate: ${JSON.stringify(signal)}`);
      const candidateObj = {
        candidate: signal.candidate,
        sdpMid: signal.sdpMid || '0',
        sdpMLineIndex: signal.sdpMLineIndex !== undefined ? signal.sdpMLineIndex : 0
      };
      if (peerConnection.remoteDescription) {
        peerConnection.addIceCandidate(new RTCIceCandidate(candidateObj))
          .catch((error) => logToUI('Error adding ICE candidate: ' + error));
      } else {
        logToUI('Buffering ICE candidate until remoteDescription is set');
        pendingCandidates.push(candidateObj);
      }
    } else {
      logToUI('No peerConnection exists to add ICE candidate');
    }
  }
}

function handleDataChannelMessage(e) {
  logToUI(`DataChannel message received, type: ${typeof e.data}`);
  if (typeof e.data === 'string') {
    const message = JSON.parse(e.data);
    logToUI(`Parsed message: ${JSON.stringify(message)}`);
    if (message.type === 'request') {
      logToUI(`Received file request for: ${message.fileName}`);
      logToUI(`sharedFilesMap contents: ${JSON.stringify([...sharedFilesMap.entries()])}`);
      const file = sharedFilesMap.get(message.fileName);
      if (file) {
        logToUI(`Found file in sharedFilesMap: ${file.name}, size: ${file.size}`);
        sendFileWithProgress(file);
      } else {
        logToUI(`File not found in sharedFilesMap: ${message.fileName}`);
      }
    } else if (message.type === 'fileSize') {
      totalSize = message.size;
      logToUI(`Expected file size: ${totalSize}`);
    } else if (message.type === 'end') {
      logToUI('Received end signal');
      receiveFileWithProgress();
    }
  } else {
    logToUI(`Received file chunk, size: ${e.data.byteLength}`);
    receivedChunks.push(e.data);
    const receivedSize = receivedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    logToUI(`Total received size: ${receivedSize}`);
    if (totalSize > 0 && receivedSize >= totalSize) {
      receiveFileWithProgress();
    }
  }
}

function sendFileWithProgress(file) {
  logToUI(`Sending file: ${file.name}, size: ${file.size}`);
  const chunkSize = 16384;
  dataChannel.send(JSON.stringify({ type: 'fileSize', size: file.size }));
  const reader = new FileReader();
  let offset = 0;

  reader.onload = (event) => {
    if (event.target.result) {
      dataChannel.send(event.target.result);
      offset += event.target.result.byteLength;
      logToUI(`Sent chunk, offset: ${offset}/${file.size}`);
      if (offset < file.size) {
        readSlice(offset);
      } else {
        dataChannel.send(JSON.stringify({ type: 'end' }));
        logToUI('File transfer complete');
      }
    }
  };

  const readSlice = (o) => {
    const slice = file.slice(offset, o + chunkSize);
    reader.readAsArrayBuffer(slice);
  };

  readSlice(0);
}

function receiveFileWithProgress() {
  logToUI('Processing received file');
  const blob = new Blob(receivedChunks);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = expectedFileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  logToUI(`File downloaded: ${expectedFileName}, size: ${blob.size}`);
  receivedChunks = [];
  totalSize = 0;
}

connectWebSocket();
