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
const hostname = window.location.hostname || 'localhost';
const port = window.location.port || (protocol === 'wss:' ? '443' : '80');
const serverUrl = `${protocol}//${hostname}:${port}`;

document.addEventListener('DOMContentLoaded', () => {
  const deviceDragDropArea = document.getElementById('deviceDragDropArea');
  const deviceFilesList = document.getElementById('deviceFiles');
  const otherFilesList = document.getElementById('otherFiles');

  if ('ontouchstart' in window || navigator.maxTouchPoints) {
    deviceDragDropArea.style.pointerEvents = 'none';
    document.querySelector('.drag-text').textContent = 'Select files using the button above';
  } else {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      deviceDragDropArea.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
      e.preventDefault();
      e.stopPropagation();
    }

    deviceDragDropArea.addEventListener('dragenter', () => deviceDragDropArea.classList.add('dragover'));
    deviceDragDropArea.addEventListener('dragover', () => deviceDragDropArea.classList.add('dragover'));
    deviceDragDropArea.addEventListener('dragleave', () => deviceDragDropArea.classList.remove('dragover'));
    deviceDragDropArea.addEventListener('drop', (e) => {
      deviceDragDropArea.classList.remove('dragover');
      const files = e.dataTransfer.files;
      handleLocalFiles(files);
    });

    deviceDragDropArea.addEventListener('click', () => document.getElementById('fileInput').click());
  }

  document.getElementById('fileInput').addEventListener('change', (e) => handleLocalFiles(e.target.files));

  document.getElementById('downloadSelected')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const checkboxes = otherFilesList.querySelectorAll('input[type="checkbox"]:checked');
    if (checkboxes.length === 0) {
      showNotification('Please select at least one file to download.', 2000);
      return;
    }

    showNotification(`Starting download of ${checkboxes.length} file${checkboxes.length > 1 ? 's' : ''}...`);
    updateProgress(0, 'Preparing download...');

    checkboxes.forEach(checkbox => {
      const fileName = checkbox.name.replace('download-', '');
      const fileOwner = files.find(f => f.name === fileName)?.ownerId;
      if (fileOwner) {
        downloadQueue.push({ ownerId: fileOwner, fileName });
      } else {
        console.error(`Owner not found for file: ${fileName}`);
        showNotification(`Error: Owner not found for ${fileName}.`, 2000);
      }
    });
    processDownloadQueue();
  });

  document.getElementById('selectAllCheckbox')?.addEventListener('change', (e) => {
    e.stopPropagation();
    const isChecked = e.target.checked;
    const checkboxes = otherFilesList.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = isChecked);
  });

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

function showNotification(message, duration = 3000) {
  const status = document.getElementById('status');
  if (!status) return; // Voorkom fouten als element ontbreekt
  status.textContent = message;
  status.style.display = 'block';
  setTimeout(() => {
    status.style.opacity = '0';
    setTimeout(() => {
      status.style.display = 'none';
      status.style.opacity = '1';
    }, 300);
  }, duration);
}

function updateProgress(percentage, message) {
  const progress = document.getElementById('progress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const progressMessage = document.getElementById('progressMessage');
  if (!progress || !progressFill || !progressText || !progressMessage) return; // Voorkom fouten

  progress.style.display = 'block';
  progressFill.style.width = `${percentage}%`;
  progressText.textContent = `${Math.round(percentage)}%`;
  progressMessage.textContent = message;

  if (percentage >= 100) {
    setTimeout(() => {
      progress.style.display = 'none';
    }, 1000);
  }
}

function processDownloadQueue() {
  if (isDownloading || downloadQueue.length === 0) return;

  isDownloading = true;
  const { ownerId, fileName } = downloadQueue.shift();
  updateProgress(0, `Starting download of ${fileName}...`);
  requestFile(ownerId, fileName);
}

async function registerDevice() {
  document.getElementById('deviceCount').textContent = 'Connecting...';
  console.log(`Attempting to connect to WebSocket at: ${serverUrl}`);
  ws = new WebSocket(serverUrl);

  ws.onopen = () => {
    console.log('WebSocket connected successfully');
    ws.send(JSON.stringify({ type: 'register' }));
    checkFolderSupport();
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    showNotification('Failed to connect to server. Please refresh.', 5000);
    document.getElementById('deviceCount').textContent = 'Failed to connect';
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed:', event);
    showNotification('Connection lost. Reconnecting...', 5000);
    document.getElementById('deviceCount').textContent = 'Connection lost';
    setTimeout(registerDevice, 2000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('Received from server:', data);
      handleMessage(data);
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
      showNotification('Invalid server message received.', 3000);
    }
  };
}

function checkFolderSupport() {
  const folderInput = document.getElementById('folderInput');
  if (!folderInput || !('webkitdirectory' in folderInput)) {
    document.getElementById('fallbackMessage')?.style.display = 'block';
    folderInput.style.display = 'none';
  }
}

function handleMessage(data) {
  if (data.type === 'register') {
    myId = data.clientId;
    console.log('Registered with ID:', myId);
  } else if (data.type === 'update') {
    console.log('Updating device count:', data.deviceCount, 'Shared files:', data.sharedFiles);
    updateDeviceCount(data.deviceCount || 0);
    updateFileLists(data.sharedFiles);
  } else if (data.type === 'signal') {
    handleSignal(data);
  }
}

function updateDeviceCount(count) {
  const deviceCountElement = document.getElementById('deviceCount');
  if (deviceCountElement) {
    deviceCountElement.textContent = `${count} device${count === 1 ? '' : 's'} connected`;
  }
}

let files = [];
function updateFileLists(sharedFiles) {
  files = sharedFiles || [];
  const deviceFilesList = document.getElementById('deviceFiles');
  const otherFilesList = document.getElementById('otherFiles');

  if (!deviceFilesList || !otherFilesList) return;

  deviceFilesList.innerHTML = '';
  const localFiles = Array.from(sharedFilesMap.values())
    .filter(f => f.ownerId === myId)
    .map(f => f.file);
  if (localFiles.length === 0 && files.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Get started by selecting files to share with connected devices.';
    deviceFilesList.appendChild(li);
  } else {
    localFiles.forEach(file => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${file.name}</span>`;
      deviceFilesList.appendChild(li);
    });
  }

  otherFilesList.innerHTML = '';
  const otherFilesExist = files.some(file => file.ownerId !== myId);
  if (!otherFilesExist && files.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Connect another device to see and download shared files here.';
    otherFilesList.appendChild(li);
  } else {
    files.forEach(file => {
      if (file.ownerId !== myId) {
        const li = document.createElement('li');
        const sizeInKB = (file.size / 1024).toFixed(2);
        li.innerHTML = `<span>${file.name} (${sizeInKB} KB)</span><input type="checkbox" name="download-${file.name}" data-owner="${file.ownerId}">`;
        otherFilesList.appendChild(li);
        if (!sharedFilesMap.has(file.name)) {
          sharedFilesMap.set(file.name, { ...file, ownerId: file.ownerId });
        }
      }
    });
  }
}

function shareFiles() {
  console.log('shareFiles() called');
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  const filesToShare = Array.from(fileInput.files).concat(Array.from(folderInput.files || []));
  if (filesToShare.length === 0) {
    showNotification('Please select files to share.', 2000);
    return;
  }
  filesToShare.forEach(file => {
    sharedFilesMap.set(file.name, { file, ownerId: myId });
    const listItem = document.createElement('li');
    listItem.innerHTML = `<span>${file.name}</span>`;
    document.getElementById('deviceFiles').appendChild(listItem);
  });
  const fileMetadata = filesToShare.map(file => ({
    name: file.name,
    size: file.size,
    timestamp: Date.now()
  }));
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'share', files: fileMetadata }));
    showNotification('Files shared successfully!', 2000);
  } else {
    console.error('WebSocket not open');
    showNotification('Error: Not connected to server.', 2000);
  }
}

function stopSharing() {
  sharedFilesMap.clear();
  ws.send(JSON.stringify({ type: 'stopSharing' }));
  showNotification('File sharing stopped.', 2000);
  document.getElementById('deviceFiles').innerHTML = '<li>Get started by selecting files to share with connected devices.</li>';
  updateFileLists(files);
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
      console.error('DataChannel not open');
      showNotification('Connection failed. Retrying...', 2000);
      isDownloading = false;
      processDownloadQueue();
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
  } catch (error) {
    console.error('Error creating RTCPeerConnection:', error);
    showNotification('WebRTC setup failed.', 3000);
    isDownloading = false;
    processDownloadQueue();
    return;
  }
  dataChannel = peerConnection.createDataChannel('fileTransfer');

  dataChannel.onopen = () => {
    console.log('DataChannel opened');
    showNotification('Connection established!', 2000);
    if (onOpenCallback) onOpenCallback();
  };
  dataChannel.onmessage = handleDataChannelMessage;
  dataChannel.onerror = (error) => {
    console.error('DataChannel error:', error);
    showNotification('Transfer error occurred.', 3000);
  };
  dataChannel.onclose = () => {
    console.log('DataChannel closed');
    isDownloading = false;
    processDownloadQueue();
  };

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
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
      isDownloading = false;
      processDownloadQueue();
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
    })
    .catch(error => {
      console.error('WebRTC setup error:', error);
      showNotification('Failed to initiate transfer.', 3000);
      isDownloading = false;
      processDownloadQueue();
    });
}

function handleSignal(data) {
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
      dataChannel.onopen = () => showNotification('Connection established!', 2000);
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
      updateProgress(0, `Receiving ${expectedFileName} (${(totalSize / 1024).toFixed(2)} KB)...`);
    } else if (message.type === 'end') {
      receiveFileWithProgress();
    }
  } else {
    receivedChunks.push(e.data);
    const receivedSize = receivedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (totalSize > 0) {
      const progress = (receivedSize / totalSize) * 100;
      updateProgress(progress, `Receiving ${expectedFileName} (${(receivedSize / 1024).toFixed(2)} KB of ${(totalSize / 1024).toFixed(2)} KB)...`);
    }
  }
}

function sendFileWithProgress(file) {
  if (dataChannel.readyState !== 'open') return;
  const chunkSize = 16384;
  file.arrayBuffer().then(buffer => {
    const totalSize = buffer.byteLength;
    dataChannel.send(JSON.stringify({ type: 'fileSize', size: totalSize }));
    
    let offset = 0;
    updateProgress(0, `Sending ${file.name} (${(totalSize / 1024).toFixed(2)} KB)...`);

    function sendNextChunk() {
      if (offset < totalSize) {
        if (dataChannel.readyState !== 'open') return;
        const chunk = buffer.slice(offset, offset + chunkSize);
        dataChannel.send(chunk);
        offset += chunkSize;
        const progress = (offset / totalSize) * 100;
        updateProgress(progress, `Sending ${file.name} (${(offset / 1024).toFixed(2)} KB of ${(totalSize / 1024).toFixed(2)} KB)...`);
        setTimeout(sendNextChunk, 10);
      } else {
        dataChannel.send(JSON.stringify({ type: 'end' }));
        updateProgress(100, `Sent ${file.name}`);
        showNotification(`Sent ${file.name} successfully!`, 2000);
      }
    }
    sendNextChunk();
  }).catch(error => {
    console.error('Error reading file buffer:', error);
    showNotification('Error sending file.', 3000);
  });
}

function receiveFileWithProgress() {
  if (receivedChunks.length > 0) {
    const receivedSize = receivedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const progress = totalSize > 0 ? (receivedSize / totalSize) * 100 : 0;
    updateProgress(progress, `Finalizing ${expectedFileName}...`);
    
    const blob = new Blob(receivedChunks);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = expectedFileName || 'downloaded_file';
    a.click();
    URL.revokeObjectURL(url);

    showNotification(`${expectedFileName} downloaded successfully!`, 2000);
    receivedChunks = [];
    totalSize = 0;
    isDownloading = false;
    processDownloadQueue();
  }
}

window.onload = registerDevice;
