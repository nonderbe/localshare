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
let downloadQueue = [];
let isDownloading = false;

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const hostname = window.location.hostname;
const serverUrl = `${protocol}//${hostname}`;

document.addEventListener('DOMContentLoaded', () => {
  const dropArea = document.getElementById('dragDropArea');
  const deviceFilesList = document.getElementById('deviceFiles');
  const otherFilesList = document.getElementById('otherFiles');

  // Mobiele optimalisatie: schakel drag-and-drop uit op touch-apparaten
  if ('ontouchstart' in window || navigator.maxTouchPoints) {
    dropArea.style.pointerEvents = 'none';
    document.querySelector('.drag-text').textContent = 'Select files using the button above';
  } else {
    // Drag-and-drop functionaliteit alleen voor niet-touch apparaten
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropArea.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
      e.preventDefault();
      e.stopPropagation();
    }

    dropArea.addEventListener('dragenter', () => dropArea.classList.add('dragover'));
    dropArea.addEventListener('dragover', () => dropArea.classList.add('dragover'));
    dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dragover'));
    dropArea.addEventListener('drop', (e) => {
      dropArea.classList.remove('dragover');
      const files = e.dataTransfer.files;
      handleLocalFiles(files);
    });

    // Klik alleen activeren als het niet in #sharedByOthers is
    dropArea.addEventListener('click', (e) => {
      if (!e.target.closest('#sharedByOthers')) {
        document.getElementById('fileInput').click();
      }
    });
  }

  document.getElementById('fileInput').addEventListener('change', (e) => {
    handleLocalFiles(e.target.files);
  });

  // Download geselecteerde bestanden
  document.getElementById('downloadSelected')?.addEventListener('click', (e) => {
    e.stopPropagation(); // Voorkom bubbling naar dropArea
    const checkboxes = otherFilesList.querySelectorAll('input[type="checkbox"]:checked');
    checkboxes.forEach(checkbox => {
      const fileName = checkbox.name.replace('download-', '');
      const fileOwner = files.find(f => f.name === fileName)?.ownerId;
      if (fileOwner) {
        downloadQueue.push({ ownerId: fileOwner, fileName });
      } else {
        console.error(`Owner not found for file: ${fileName}`);
      }
    });
    processDownloadQueue();
  });

  // "Select All" checkbox functionaliteit
  document.getElementById('selectAllCheckbox')?.addEventListener('change', (e) => {
    e.stopPropagation();
    const isChecked = e.target.checked;
    const checkboxes = otherFilesList.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = isChecked);
  });

  // Eigen bestanden verwerken
  function handleLocalFiles(files) {
    Array.from(files).forEach(file => {
      const listItem = document.createElement('li');
      listItem.innerHTML = `<span>${file.name}</span>`;
      deviceFilesList.appendChild(listItem);
      sharedFilesMap.set(file.name, { file, ownerId: myId });
      shareFilesToNetwork(file);
    });
  }
});

function processDownloadQueue() {
  if (isDownloading || downloadQueue.length === 0) return;

  isDownloading = true;
  const { ownerId, fileName } = downloadQueue.shift();
  requestFile(ownerId, fileName);
}

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
    updateFileLists(data.sharedFiles);
  } else if (data.type === 'signal') {
    handleSignal(data);
  }
}

function updateDeviceCount(count) {
  document.getElementById('deviceCount').textContent = 
    `${count} device${count === 1 ? '' : 's'} connected`;
}

let files = [];
function updateFileLists(sharedFiles) {
  files = sharedFiles;
  const deviceFilesList = document.getElementById('deviceFiles');
  const otherFilesList = document.getElementById('otherFiles');
  
  // Eigen bestanden bijwerken
  deviceFilesList.innerHTML = '';
  const localFiles = Array.from(sharedFilesMap.values())
    .filter(f => f.ownerId === myId)
    .map(f => f.file);
  localFiles.forEach(file => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${file.name}</span>`;
    deviceFilesList.appendChild(li);
  });

  // Bestanden van anderen bijwerken
  otherFilesList.innerHTML = '';
  sharedFiles.forEach(file => {
    if (file.ownerId !== myId) {
      const li = document.createElement('li');
      const sizeInKB = (file.size / 1024).toFixed(2);
      li.innerHTML = `<span>${file.name} (${sizeInKB} KB)</span><input type="checkbox" name="download-${file.name}">`;
      otherFilesList.appendChild(li);
      sharedFilesMap.set(file.name, { ...file, ownerId: file.ownerId });
    }
  });

  // Verberg de oude #fileList
  document.getElementById('fileList').style.display = 'none';
}

function shareFiles() {
  console.log('shareFiles() called');
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  const files = Array.from(fileInput.files).concat(Array.from(folderInput.files || []));
  files.forEach(file => {
    sharedFilesMap.set(file.name, { file, ownerId: myId });
    const listItem = document.createElement('li');
    listItem.innerHTML = `<span>${file.name}</span>`;
    document.getElementById('deviceFiles').appendChild(listItem);
  });
  const fileMetadata = files.map(file => ({
    name: file.name,
    size: file.size,
    timestamp: Date.now()
  }));
  if (files.length > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'share', files: fileMetadata }));
    document.getElementById('status').textContent = 'Files shared!';
  } else {
    console.error('No files or WebSocket not open');
  }
}

function stopSharing() {
  sharedFilesMap.clear();
  ws.send(JSON.stringify({ type: 'stopSharing' }));
  document.getElementById('status').textContent = 'File sharing stopped.';
  document.getElementById('deviceFiles').innerHTML = '';
  document.getElementById('otherFiles').innerHTML = '';
}

function shareFilesToNetwork(file) {
  const fileMetadata = { name: file.name, size: file.size, timestamp: Date.now() };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'share', files: [fileMetadata] }));
  }
}

function requestFile(ownerId, fileName) {
  console.log('requestFile called - ownerId:', ownerId, 'fileName:', fileName);
  targetId = ownerId;
  expectedFileName = fileName;
  receivedChunks = [];
  totalSize = 0;
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
    dataChannel = null;
  }
  setupWebRTC(() => {
    if (dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'request', fileName }));
    } else {
      console.error('DataChannel not open, cannot send request');
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
      ws.send(JSON.stringify({
        type: 'signal',
        targetId,
        signal: { candidate: e.candidate },
      }));
    }
  };
  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'disconnected') {
      peerConnection.close();
      peerConnection = null;
      dataChannel = null;
    }
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
    .catch(error => console.error('WebRTC setup error:', error));
}

function handleSignal(data) {
  console.log('Received signal from:', data.fromId, 'for target:', data.targetId);
  if (data.signal.type === 'offer') {
    if (peerConnection && peerConnection.signalingState !== 'closed') {
      peerConnection.close();
      peerConnection = null;
      dataChannel = null;
    }
    peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:numb.viagenie.ca:3478', username: 'webrtc@live.com', credential: 'muazkh' }
      ]
    });

    peerConnection.ondatachannel = (e) => {
      dataChannel = e.channel;
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
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: data.fromId,
          signal: { candidate: e.candidate },
        }));
      }
    };
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'disconnected') {
        peerConnection.close();
        peerConnection = null;
        dataChannel = null;
      }
    };

    peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        while (pendingCandidates.length > 0) {
          peerConnection.addIceCandidate(new RTCIceCandidate(pendingCandidates.shift()));
        }
        return peerConnection.createAnswer();
      })
      .then(answer => peerConnection.setLocalDescription(answer))
      .then(() => {
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: data.fromId,
          signal: peerConnection.localDescription,
        }));
      })
      .catch(error => console.error('Error handling offer:', error));
  } else if (data.signal.type === 'answer') {
    if (!peerConnection) return;
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        while (pendingCandidates.length > 0) {
          peerConnection.addIceCandidate(new RTCIceCandidate(pendingCandidates.shift()));
        }
      })
      .catch(error => console.error('Error handling answer:', error));
  } else if (data.signal.candidate) {
    if (!peerConnection) return;
    if (peerConnection.remoteDescription) {
      peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate))
        .catch(error => console.error('Error adding ICE candidate:', error));
    } else {
      pendingCandidates.push(data.signal.candidate);
    }
  }
}

function handleDataChannelMessage(e) {
  if (typeof e.data === 'string') {
    const message = JSON.parse(e.data);
    if (message.type === 'request') {
      const file = sharedFilesMap.get(message.fileName)?.file;
      if (file) sendFileWithProgress(file);
    } else if (message.type === 'fileSize') {
      totalSize = message.size;
    } else if (message.type === 'end') {
      receiveFileWithProgress();
    }
  } else {
    receivedChunks.push(e.data);
    const receivedSize = receivedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (totalSize > 0 && receivedSize >= totalSize) receiveFileWithProgress();
  }
}

function sendFileWithProgress(file) {
  if (dataChannel.readyState !== 'open') return;
  const chunkSize = 16384;
  file.arrayBuffer().then(buffer => {
    const totalSize = buffer.byteLength;
    dataChannel.send(JSON.stringify({ type: 'fileSize', size: totalSize }));
    
    let offset = 0;
    const progressBar = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');

    progressBar.style.display = 'block';
    document.getElementById('status').textContent = `Sending ${file.name}...`;

    function sendNextChunk() {
      if (offset < totalSize) {
        if (dataChannel.readyState !== 'open') return;
        const chunk = buffer.slice(offset, offset + chunkSize);
        dataChannel.send(chunk);
        offset += chunkSize;
        const progress = (offset / totalSize) * 100;
        progressFill.style.width = `${progress}%`;
        setTimeout(sendNextChunk, 10);
      } else {
        dataChannel.send(JSON.stringify({ type: 'end' }));
        progressBar.style.display = 'none';
        document.getElementById('status').textContent = `Sent ${file.name}`;
      }
    }
    sendNextChunk();
  }).catch(error => console.error('Error reading file buffer:', error));
}

function receiveFileWithProgress() {
  if (receivedChunks.length > 0) {
    const blob = new Blob(receivedChunks);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = expectedFileName || 'downloaded_file';
    a.click();
    document.getElementById('status').textContent = 'File downloaded!';
    document.getElementById('progress').style.display = 'none';
    console.log('Download triggered for:', expectedFileName);
    receivedChunks = [];
    totalSize = 0;

    // Download voltooid, ga verder met de wachtrij
    isDownloading = false;
    processDownloadQueue();
  }
}

window.onload = registerDevice;
