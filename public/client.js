function logToUI(message) {
  console.log(message);
  const logContainer = document.getElementById('logContainer');
  const logEntry = document.createElement('div');
  logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContainer.appendChild(logEntry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

logToUI('client.js loaded successfully');

let ws;
let peerConnection;
let dataChannel;
let myId;
let targetId;
let sharedFilesMap = new Map();
let pendingCandidates = [];
let receivedChunks = [];
let expectedFileName;
let totalSize = 0;

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const hostname = window.location.hostname;
const serverUrl = `${protocol}//${hostname}`;

async function registerDevice() {
  document.getElementById('deviceCount').textContent = 'Connecting...';

  logToUI(`Attempting to connect to WebSocket at: ${serverUrl}`);
  ws = new WebSocket(serverUrl);

  ws.onopen = () => {
    logToUI('WebSocket connected successfully');
    ws.send(JSON.stringify({ type: 'register' }));
    updateDeviceCount(1);
    checkFolderSupport();
  };

  ws.onerror = (error) => {
    logToUI(`WebSocket error: ${JSON.stringify(error)}`);
    document.getElementById('deviceCount').textContent = 'Error: Could not connect to server.';
  };

  ws.onclose = (event) => {
    logToUI(`WebSocket closed: ${JSON.stringify(event)}`);
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
  logToUI(`Received from server: ${JSON.stringify(data)}`);
  if (data.type === 'register') {
    myId = data.clientId;
  } else if (data.type === 'update') {
    logToUI(`Processing update - Device count: ${data.deviceCount} Files: ${JSON.stringify(data.sharedFiles)}`);
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
  logToUI(`Files received for list: ${JSON.stringify(files)}`);
  files.forEach(file => {
    logToUI(`Processing file: ${file.name} Owner: ${file.ownerId} My ID: ${myId}`);
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
  logToUI('shareFiles() called');
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  logToUI(`Raw fileInput.files: ${JSON.stringify(fileInput.files)}`);
  logToUI(`Raw folderInput.files: ${JSON.stringify(folderInput.files)}`);
  const files = Array.from(fileInput.files).concat(Array.from(folderInput.files || []));
  logToUI(`Combined files: ${JSON.stringify(files)}`);
  files.forEach(file => sharedFilesMap.set(file.name, file));
  const fileMetadata = files.map(file => ({
    name: file.name,
    size: file.size,
    timestamp: Date.now()
  }));
  logToUI(`File metadata to send: ${JSON.stringify(fileMetadata)}`);
  if (files.length > 0) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'share', files: fileMetadata }));
      document.getElementById('status').textContent = 'Files shared!';
    } else {
      logToUI('WebSocket not open, cannot share files');
      document.getElementById('status').textContent = 'Error: Cannot share - connection lost.';
    }
  } else {
    logToUI('No files selected to share');
  }
}

function stopSharing() {
  sharedFilesMap.clear();
  ws.send(JSON.stringify({ type: 'stopSharing' }));
  document.getElementById('status').textContent = 'File sharing stopped.';
}

function requestFile(ownerId, fileName) {
  logToUI(`requestFile called - ownerId: ${ownerId} fileName: ${fileName}`);
  targetId = ownerId;
  expectedFileName = fileName;
  receivedChunks = [];
  totalSize = 0;
  if (peerConnection) {
    logToUI('Closing existing peerConnection before new request');
    peerConnection.close();
    peerConnection = null;
    dataChannel = null;
  }
  setupWebRTC(() => {
    logToUI(`DataChannel opened, sending request for: ${fileName} readyState: ${dataChannel.readyState}`);
    try {
      if (dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'request', fileName }));
      } else {
        logToUI('DataChannel not open, cannot send request');
      }
    } catch (error) {
      logToUI(`Error sending request: ${JSON.stringify(error)}`);
    }
  });
}

function setupWebRTC(onOpenCallback) {
  logToUI('Setting up WebRTC connection');
  try {
    peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:109.236.133.105:3478', username: ´test´, credential: 'test123' } // Nieuwe TURN-server
      ]
    });
    logToUI('RTCPeerConnection created');
  } catch (error) {
    logToUI(`Error creating RTCPeerConnection: ${JSON.stringify(error)}`);
    return;
  }
  dataChannel = peerConnection.createDataChannel('fileTransfer');
  logToUI('DataChannel created');

  dataChannel.onopen = () => {
    logToUI('DataChannel opened');
    document.getElementById('status').textContent = 'Connection established!';
    if (onOpenCallback) onOpenCallback();
  };
  dataChannel.onmessage = handleDataChannelMessage;
  dataChannel.onerror = (error) => logToUI(`DataChannel error: ${JSON.stringify(error)}`);
  dataChannel.onclose = () => logToUI('DataChannel closed');

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      logToUI(`ICE candidate found: ${e.candidate.candidate}`);
      try {
        ws.send(JSON.stringify({
          type: 'signal',
          targetId,
          signal: { candidate: e.candidate },
        }));
        logToUI(`ICE candidate sent to: ${targetId}`);
      } catch (error) {
        logToUI(`Error sending ICE candidate: ${JSON.stringify(error)}`);
      }
    } else {
      logToUI('ICE candidate gathering complete');
    }
  };
  peerConnection.onconnectionstatechange = () => {
    logToUI(`Connection state: ${peerConnection.connectionState}`);
    if (peerConnection.connectionState === 'disconnected') {
      logToUI('Connection disconnected, closing peerConnection');
      peerConnection.close();
      peerConnection = null;
      dataChannel = null;
    }
  };
  peerConnection.oniceconnectionstatechange = () => {
    logToUI(`ICE connection state: ${peerConnection.iceConnectionState}`);
  };
  peerConnection.onsignalingstatechange = () => {
    logToUI(`Signaling state: ${peerConnection.signalingState}`);
  };
  peerConnection.onicecandidateerror = (e) => {
    logToUI(`ICE candidate error: ${e.errorText} URL: ${e.url}`);
  };

  logToUI('Creating offer');
  peerConnection.createOffer()
    .then(offer => {
      logToUI(`Offer created: ${offer.sdp.substring(0, 100)}...`);
      return peerConnection.setLocalDescription(offer);
    })
    .then(() => {
      logToUI(`Local description set, sending offer to target: ${targetId}`);
      ws.send(JSON.stringify({
        type: 'signal',
        targetId,
        signal: peerConnection.localDescription,
      }));
    })
    .catch(error => {
      logToUI(`WebRTC setup error: ${JSON.stringify(error)}`);
    });
}

function handleSignal(data) {
  logToUI(`Received signal from: ${data.fromId} for target: ${data.targetId}`);
  if (data.signal.type === 'offer') {
    if (peerConnection && peerConnection.signalingState !== 'closed') {
      logToUI('Closing existing peerConnection for new offer');
      peerConnection.close();
      peerConnection = null;
      dataChannel = null;
    }
    logToUI('Creating new RTCPeerConnection for incoming offer');
    peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80' }
      ]
    });
    logToUI('RTCPeerConnection created (responder)');

    peerConnection.ondatachannel = (e) => {
      dataChannel = e.channel;
      logToUI(`Incoming DataChannel received: ${e.channel.label}`);
      dataChannel.onopen = () => {
        logToUI('Incoming DataChannel opened');
        document.getElementById('status').textContent = 'Connection established!';
      };
      dataChannel.onmessage = handleDataChannelMessage;
      dataChannel.onerror = (error) => logToUI(`Incoming DataChannel error: ${JSON.stringify(error)}`);
      dataChannel.onclose = () => logToUI('Incoming DataChannel closed');
    };
    peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        logToUI(`ICE candidate found (responder): ${e.candidate.candidate}`);
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: data.fromId,
          signal: { candidate: e.candidate },
        }));
      } else {
        logToUI('ICE candidate gathering complete (responder)');
      }
    };
    peerConnection.onconnectionstatechange = () => {
      logToUI(`Connection state (responder): ${peerConnection.connectionState}`);
      if (peerConnection.connectionState === 'disconnected') {
        logToUI('Connection disconnected (responder), closing peerConnection');
        peerConnection.close();
        peerConnection = null;
        dataChannel = null;
      }
    };
    peerConnection.oniceconnectionstatechange = () => {
      logToUI(`ICE connection state (responder): ${peerConnection.iceConnectionState}`);
    };
    peerConnection.onicecandidateerror = (e) => {
      logToUI(`ICE candidate error (responder): ${e.errorText} URL: ${e.url}`);
    };

    logToUI('Handling offer');
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        logToUI('Remote description set');
        while (pendingCandidates.length > 0) {
          const candidate = pendingCandidates.shift();
          logToUI(`Adding buffered ICE candidate: ${JSON.stringify(candidate)}`);
          peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        return peerConnection.createAnswer();
      })
      .then(answer => {
        logToUI('Answer created');
        return peerConnection.setLocalDescription(answer);
      })
      .then(() => {
        logToUI(`Sending answer to: ${data.fromId}`);
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: data.fromId,
          signal: peerConnection.localDescription,
        }));
      })
      .catch(error => logToUI(`Error handling offer: ${JSON.stringify(error)}`));
  } else if (data.signal.type === 'answer') {
    if (!peerConnection) {
      logToUI('No peerConnection exists to handle answer');
      return;
    }
    logToUI('Handling answer');
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        logToUI('Remote description set for answer');
        while (pendingCandidates.length > 0) {
          const candidate = pendingCandidates.shift();
          logToUI(`Adding buffered ICE candidate after answer: ${JSON.stringify(candidate)}`);
          peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
      })
      .catch(error => logToUI(`Error handling answer: ${JSON.stringify(error)}`));
  } else if (data.signal.candidate) {
    logToUI(`Received ICE candidate: ${JSON.stringify(data.signal.candidate)}`);
    if (!peerConnection) {
      logToUI('No peerConnection exists to add ICE candidate');
      return;
    }
    if (peerConnection.remoteDescription) {
      peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate))
        .catch(error => logToUI(`Error adding ICE candidate: ${JSON.stringify(error)}`));
    } else {
      logToUI('Buffering ICE candidate until remote description is set');
      pendingCandidates.push(data.signal.candidate);
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
      const file = sharedFilesMap.get(message.fileName);
      if (file) {
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
  logToUI(`Sending file: ${file.name} DataChannel readyState: ${dataChannel.readyState}`);
  if (dataChannel.readyState !== 'open') {
    logToUI('DataChannel not open, cannot send file');
    return;
  }
  const chunkSize = 16384;
  file.arrayBuffer().then(buffer => {
    const totalSize = buffer.byteLength;
    logToUI(`Sending file size info: ${totalSize}`);
    dataChannel.send(JSON.stringify({ type: 'fileSize', size: totalSize }));
    
    let offset = 0;
    const progressBar = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');

    progressBar.style.display = 'block';
    document.getElementById('status').textContent = `Sending ${file.name}...`;

    function sendNextChunk() {
      if (offset < totalSize) {
        if (dataChannel.readyState !== 'open') {
          logToUI('DataChannel closed during sending, aborting');
          return;
        }
        const chunk = buffer.slice(offset, offset + chunkSize);
        dataChannel.send(chunk);
        logToUI(`Sent chunk, size: ${chunk.byteLength} offset: ${offset}`);
        offset += chunkSize;
        const progress = (offset / totalSize) * 100;
        progressFill.style.width = `${progress}%`;
        setTimeout(sendNextChunk, 10);
      } else {
        logToUI('Sending end signal');
        dataChannel.send(JSON.stringify({ type: 'end' }));
        progressBar.style.display = 'none';
        document.getElementById('status').textContent = `Sent ${file.name}`;
        logToUI(`File sending complete, total size: ${totalSize}`);
        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
          dataChannel = null;
          logToUI('PeerConnection closed after sending');
        }
      }
    }
    sendNextChunk();
  }).catch(error => logToUI(`Error reading file buffer: ${JSON.stringify(error)}`));
}

function receiveFileWithProgress() {
  if (receivedChunks.length > 0) {
    logToUI(`Processing received chunks, total chunks: ${receivedChunks.length}`);
    const blob = new Blob(receivedChunks);
    const receivedSize = blob.size;
    logToUI(`Combined blob size: ${receivedSize}`);
    if (totalSize > 0 && receivedSize >= totalSize) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = expectedFileName || 'downloaded_file';
      a.click();
      document.getElementById('status').textContent = 'File downloaded!';
      document.getElementById('progress').style.display = 'none';
      logToUI(`Download triggered for: ${expectedFileName} size: ${receivedSize}`);
      receivedChunks = [];
      totalSize = 0;
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
        dataChannel = null;
        logToUI('PeerConnection closed after download');
      }
    } else {
      logToUI('Waiting for more chunks or end signal');
    }
  }
}

window.onload = registerDevice;
