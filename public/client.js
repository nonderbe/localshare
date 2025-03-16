console.log('client.js loaded successfully');

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

  console.log(`Attempting to connect to WebSocket at: ${serverUrl}`);
  ws = new WebSocket(serverUrl);

  ws.onopen = () => {
    console.log('WebSocket connected successfully');
    ws.send(JSON.stringify({ type: 'register' }));
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

function stopSharing() {
  sharedFilesMap.clear();
  ws.send(JSON.stringify({ type: 'stopSharing' }));
  document.getElementById('status').textContent = 'File sharing stopped.';
}

function requestFile(ownerId, fileName) {
  console.log('requestFile called - ownerId:', ownerId, 'fileName:', fileName);
  targetId = ownerId;
  expectedFileName = fileName;
  receivedChunks = [];
  totalSize = 0;
  if (peerConnection) {
    console.log('Closing existing peerConnection before new request');
    peerConnection.close();
  }
  setupWebRTC(() => {
    console.log('DataChannel opened, sending request for:', fileName, 'readyState:', dataChannel.readyState);
    try {
      if (dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'request', fileName }));
      } else {
        console.error('DataChannel not open, cannot send request');
      }
    } catch (error) {
      console.error('Error sending request:', error);
    }
  });
}

function setupWebRTC(onOpenCallback) {
  console.log('Setting up WebRTC connection');
  try {
    peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:numb.viagenie.ca:3478', username: 'webrtc@live.com', credential: 'muazkh' }
      ]
    });
    console.log('RTCPeerConnection created');
  } catch (error) {
    console.error('Error creating RTCPeerConnection:', error);
    return;
  }
  dataChannel = peerConnection.createDataChannel('fileTransfer');
  console.log('DataChannel created');

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
  peerConnection.onsignalingstatechange = () => {
    console.log('Signaling state:', peerConnection.signalingState);
  };
  peerConnection.onicecandidateerror = (e) => {
    console.error('ICE candidate error:', e.errorText, 'URL:', e.url);
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
  if (!peerConnection || peerConnection.signalingState === 'closed') {
    console.log('Creating new RTCPeerConnection for incoming signal');
    peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:numb.viagenie.ca:3478', username: 'webrtc@live.com', credential: 'muazkh' }
      ]
    });
    console.log('RTCPeerConnection created (responder)');

    peerConnection.ondatachannel = (e) => {
      dataChannel = e.channel;
      console.log('Incoming DataChannel received:', e.channel.label);
      dataChannel.onopen = () => {
        console.log('Incoming DataChannel opened');
        document.getElementById('status').textContent = 'Connection established!';
      };
      dataChannel.onmessage = handleDataChannelMessage;
      dataChannel.onerror = (error) => console.error('Incoming DataChannel error:', error);
      dataChannel.onclose = () => console.log('Incoming DataChannel closed');
    };
    peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        console.log('ICE candidate found (responder):', e.candidate.candidate);
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: data.fromId,
          signal: { candidate: e.candidate },
        }));
      } else {
        console.log('ICE candidate gathering complete (responder)');
      }
    };
    peerConnection.onconnectionstatechange = () => {
      console.log('Connection state (responder):', peerConnection.connectionState);
    };
    peerConnection.oniceconnectionstatechange = () => {
      console.log('ICE connection state (responder):', peerConnection.iceConnectionState);
    };
    peerConnection.onicecandidateerror = (e) => {
      console.error('ICE candidate error (responder):', e.errorText, 'URL:', e.url);
    };
  } else {
    console.log('Using existing RTCPeerConnection, signalingState:', peerConnection.signalingState);
  }

  if (data.signal.type === 'offer') {
    console.log('Handling offer');
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        console.log('Remote description set');
        while (pendingCandidates.length > 0) {
          const candidate = pendingCandidates.shift();
          console.log('Adding buffered ICE candidate:', candidate);
          peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        return peerConnection.createAnswer();
      })
      .then(answer => {
        console.log('Answer created');
        return peerConnection.setLocalDescription(answer);
      })
      .then(() => {
        console.log('Sending answer to:', data.fromId);
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: data.fromId,
          signal: peerConnection.localDescription,
        }));
      })
      .catch(error => console.error('Error handling offer:', error));
  } else if (data.signal.type === 'answer') {
    console.log('Handling answer');
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        console.log('Remote description set for answer');
        while (pendingCandidates.length > 0) {
          const candidate = pendingCandidates.shift();
          console.log('Adding buffered ICE candidate after answer:', candidate);
          peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
      })
      .catch(error => console.error('Error handling answer:', error));
  } else if (data.signal.candidate) {
    console.log('Received ICE candidate:', data.signal.candidate);
    if (peerConnection.remoteDescription) {
      peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate))
        .catch(error => console.error('Error adding ICE candidate:', error));
    } else {
      console.log('Buffering ICE candidate until remote description is set');
      pendingCandidates.push(data.signal.candidate);
    }
  }
}

function handleDataChannelMessage(e) {
  if (typeof e.data === 'string') {
    const message = JSON.parse(e.data);
    if (message.type === 'request') {
      console.log('Received file request for:', message.fileName);
      const file = sharedFilesMap.get(message.fileName);
      if (file) {
        sendFileWithProgress(file);
      } else {
        console.error('File not found in sharedFilesMap:', message.fileName);
      }
    } else if (message.type === 'fileSize') {
      totalSize = message.size;
      console.log('Expected file size:', totalSize);
    } else if (message.type === 'end') {
      console.log('Received end signal');
      receiveFileWithProgress();
    }
  } else {
    console.log('Received file chunk, size:', e.data.byteLength);
    receivedChunks.push(e.data);
    const receivedSize = receivedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    console.log('Total received size:', receivedSize);
    if (totalSize > 0 && receivedSize >= totalSize) {
      receiveFileWithProgress();
    }
  }
}

function sendFileWithProgress(file) {
  console.log('Sending file:', file.name, 'DataChannel readyState:', dataChannel.readyState);
  if (dataChannel.readyState !== 'open') {
    console.error('DataChannel not open, cannot send file');
    return;
  }
  const chunkSize = 16384;
  file.arrayBuffer().then(buffer => {
    const totalSize = buffer.byteLength;
    console.log('Sending file size info:', totalSize);
    dataChannel.send(JSON.stringify({ type: 'fileSize', size: totalSize }));
    
    let offset = 0;
    const progressBar = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');

    progressBar.style.display = 'block';
    document.getElementById('status').textContent = `Sending ${file.name}...`;

    function sendNextChunk() {
      if (offset < totalSize) {
        if (dataChannel.readyState !== 'open') {
          console.error('DataChannel closed during sending, aborting');
          return;
        }
        const chunk = buffer.slice(offset, offset + chunkSize);
        dataChannel.send(chunk);
        console.log('Sent chunk, size:', chunk.byteLength, 'offset:', offset);
        offset += chunkSize;
        const progress = (offset / totalSize) * 100;
        progressFill.style.width = `${progress}%`;
        setTimeout(sendNextChunk, 10);
      } else {
        console.log('Sending end signal');
        dataChannel.send(JSON.stringify({ type: 'end' }));
        progressBar.style.display = 'none';
        document.getElementById('status').textContent = `Sent ${file.name}`;
        console.log('File sending complete, total size:', totalSize);
      }
    }
    sendNextChunk();
  }).catch(error => console.error('Error reading file buffer:', error));
}

function receiveFileWithProgress() {
  if (receivedChunks.length > 0) {
    console.log('Processing received chunks, total chunks:', receivedChunks.length);
    const blob = new Blob(receivedChunks);
    const receivedSize = blob.size;
    console.log('Combined blob size:', receivedSize);
    if (totalSize > 0 && receivedSize >= totalSize) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = expectedFileName || 'downloaded_file';
      a.click();
      document.getElementById('status').textContent = 'File downloaded!';
      document.getElementById('progress').style.display = 'none';
      console.log('Download triggered for:', expectedFileName, 'size:', receivedSize);
      receivedChunks = [];
      totalSize = 0;
    } else {
      console.log('Waiting for more chunks or end signal');
    }
  }
}

window.onload = registerDevice;