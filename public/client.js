console.log('client.js loaded successfully');

let ws;
let peerConnection;
let dataChannel;
let myId;
let targetId;
let sharedFilesMap = new Map();
let pendingCandidates = [];
let isDownloading = false;
let isSharing = true;
const transfers = new Map(); // Track transfers: { fileId: { fileName, totalSize, receivedSize/sentSize, chunks, progressBarId, direction } }
let downloadQueue = [];
let files = [];

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const hostname = window.location.hostname;
const serverUrl = `${protocol}//${hostname}`;

// Create a unique progress bar for a file transfer
function createProgressBar(fileId, fileName, direction) {
  const container = document.getElementById('progressContainer');
  const barId = `progress-${fileId}`;
  const html = `
    <div id="${barId}" class="progress-bar">
      <div id="${barId}-fill" class="progress-fill"></div>
      <span id="${barId}-text" class="progress-text ${direction}">${direction === 'send' ? 'Sending' : 'Preparing to receive'} ${fileName}</span>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', html);
  return barId;
}

// Update progress for a specific file transfer
function updateProgress(fileId, percentage, message, direction) {
  const progressBar = document.getElementById(`progress-${fileId}`);
  const progressFill = document.getElementById(`progress-${fileId}-fill`);
  const progressText = document.getElementById(`progress-${fileId}-text`);

  if (!progressBar || !progressFill || !progressText) {
    console.error('Progress elements not found for fileId:', fileId);
    return;
  }

  const safePercentage = isNaN(percentage) || percentage < 0 ? 0 : Math.min(percentage, 100);
  console.log(`Updating progress for ${fileId}: ${safePercentage}% - ${message}`);

  progressBar.style.display = 'block';
  progressBar.style.visibility = 'visible';
  progressBar.style.opacity = '1';
  progressFill.style.width = `${safePercentage}%`;
  if (direction === 'setup') {
    progressText.textContent = message; // WebRTC setup messages
  } else {
    progressText.textContent = `${direction === 'send' ? 'Sending' : 'Receiving'} ${transfers.get(fileId)?.fileName || 'File'} at ${Math.round(safePercentage)}%`;
  }

  const computedStyle = getComputedStyle(progressBar);
  console.log(`Progress bar styles for ${fileId}: display=${computedStyle.display}, visibility=${computedStyle.visibility}, opacity=${computedStyle.opacity}, width=${progressFill.style.width}`);

  if (safePercentage >= 100 && direction !== 'setup') {
    setTimeout(() => {
      progressBar.remove();
      transfers.delete(fileId);
      console.log(`Removed progress bar for ${fileId}`);
    }, 1000);
  }
}

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

    deviceDragDropArea.addEventListener('click', () => {
      document.getElementById('fileInput').click();
    });
  }

  document.getElementById('fileInput').addEventListener('change', (e) => {
    handleLocalFiles(e.target.files);
  });

  document.getElementById('downloadSelected')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const checkboxes = otherFilesList.querySelectorAll('input[type="checkbox"]:checked');
    if (checkboxes.length === 0) {
      console.log('No files selected for download');
      return;
    }
    console.log(`Starting download of ${checkboxes.length} file${checkboxes.length > 1 ? 's' : ''}`);
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
      shareFilesToNetwork();
    });
  }
});

function processDownloadQueue() {
  if (isDownloading || downloadQueue.length === 0) return;

  isDownloading = true;
  const { ownerId, fileName } = downloadQueue.shift();
  const fileId = Date.now().toString() + '-' + fileName; // Unique fileId
  transfers.set(fileId, {
    fileName,
    totalSize: 0,
    receivedSize: 0,
    chunks: [],
    progressBarId: createProgressBar(fileId, fileName, 'receive'),
    direction: 'receive'
  });
  updateProgress(fileId, 0, `Starting download of ${fileName}...`, 'setup');
  requestFile(ownerId, fileName, fileId);
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
    // Re-share all files in sharedFilesMap on reconnect
    if (sharedFilesMap.size > 0) {
      shareFilesToNetwork();
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    document.getElementById('deviceCount').textContent = 'Failed to connect. Please refresh the page.';
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed:', event);
    document.getElementById('deviceCount').textContent = 'Connection lost. Reconnecting...';
    setTimeout(registerDevice, 2000);
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

function updateFileLists(sharedFiles) {
  files = sharedFiles;
  const deviceFilesList = document.getElementById('deviceFiles');
  const otherFilesList = document.getElementById('otherFiles');

  // Update local files (deviceFilesList)
  deviceFilesList.innerHTML = '';
  const localFiles = Array.from(sharedFilesMap.values())
    .filter(f => f.ownerId === myId)
    .map(f => f.file);
  if (localFiles.length === 0 && sharedFiles.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No files shared yet. Select files above to start.';
    deviceFilesList.appendChild(li);
  } else {
    localFiles.forEach(file => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${file.name}</span>`;
      deviceFilesList.appendChild(li);
    });
  }

  // Update other devices' files (otherFilesList)
  const existingFiles = new Map(files.map(f => [f.name + f.ownerId, f]));
  const newFiles = sharedFiles.filter(file => file.ownerId !== myId);
  newFiles.forEach(file => {
    existingFiles.set(file.name + file.ownerId, file);
  });

  otherFilesList.innerHTML = '';
  const otherFiles = Array.from(existingFiles.values()).filter(file => file.ownerId !== myId);
  if (otherFiles.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No files available yet. Connect another device to see shared files.';
    otherFilesList.appendChild(li);
  } else {
    otherFiles.forEach(file => {
      const li = document.createElement('li');
      const sizeInKB = (file.size / 1024).toFixed(2);
      li.innerHTML = `<span>${file.name} (${sizeInKB} KB)</span><input type="checkbox" name="download-${file.name}">`;
      otherFilesList.appendChild(li);
      sharedFilesMap.set(file.name, { ...file, ownerId: file.ownerId });
    });
  }
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
  shareFilesToNetwork();
}

function stopSharing() {
  isSharing = false;
  sharedFilesMap.clear();
  document.getElementById('deviceFiles').innerHTML = '';
  console.log('Stopped sharing, notifying peers');

  // Cancel only sending transfers
  for (const [fileId, transfer] of transfers) {
    if (transfer.direction === 'send') {
      if (dataChannel?.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'stop', fileId, fileName: transfer.fileName }));
      }
      const progressBar = document.getElementById(`progress-${fileId}`);
      if (progressBar) progressBar.remove();
      transfers.delete(fileId);
    }
  }

  // Notify server and close sending connections
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stopSharing' }));
  }
  if (peerConnection && dataChannel?.readyState === 'open') {
    const hasReceiving = Array.from(transfers.values()).some(t => t.direction === 'receive');
    if (!hasReceiving) {
      dataChannel.close();
      peerConnection.close();
      dataChannel = null;
      peerConnection = null;
    }
  }
}

function shareFilesToNetwork() {
  const fileMetadata = Array.from(sharedFilesMap.values())
    .filter(f => f.ownerId === myId)
    .map(f => ({
      name: f.file.name,
      size: f.file.size,
      timestamp: Date.now(),
      ownerId: myId
    }));
  if (fileMetadata.length > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'share', files: fileMetadata }));
    console.log('Shared files:', fileMetadata);
  } else {
    console.error('No files to share or WebSocket not open');
  }
}

function requestFile(ownerId, fileName, fileId) {
  console.log('requestFile called - ownerId:', ownerId, 'fileName:', fileName, 'fileId:', fileId);
  targetId = ownerId;
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
    dataChannel = null;
  }
  updateProgress(fileId, 0, `Creating WebRTC offer for ${fileName}...`, 'setup');
  setupWebRTC(() => {
    if (dataChannel?.readyState === 'open') {
      updateProgress(fileId, 0, `Requesting ${fileName} from peer...`, 'setup');
      dataChannel.send(JSON.stringify({ type: 'request', fileName, fileId }));
    } else {
      console.error('DataChannel not open, cannot send request');
      updateProgress(fileId, 0, `Failed to establish connection for ${fileName}`, 'setup');
      transfers.delete(fileId);
      isDownloading = false;
      processDownloadQueue();
    }
  });
}

function setupWebRTC(onOpenCallback) {
  console.log('Setting up WebRTC connection');
  const fileId = Array.from(transfers.keys()).find(id => transfers.get(id).direction === 'receive');
  try {
    peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ]
    });
  /*  peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:numb.viagenie.ca:3478', username: 'webrtc@live.com', credential: 'muazkh' }
      ]
    });*/
    console.log('RTCPeerConnection created');
    updateProgress(fileId, 0, `WebRTC connection initialized for ${transfers.get(fileId)?.fileName}...`, 'setup');
  } catch (error) {
    console.error('Error creating RTCPeerConnection:', error);
    updateProgress(fileId, 0, `Failed to initialize WebRTC for ${transfers.get(fileId)?.fileName}`, 'setup');
    return;
  }
  dataChannel = peerConnection.createDataChannel('fileTransfer', { binaryType: 'arraybuffer' });
  console.log('DataChannel created with binaryType: arraybuffer');

  dataChannel.onopen = () => {
    console.log('DataChannel opened');
    updateProgress(fileId, 0, `Connection established for ${transfers.get(fileId)?.fileName}`, 'setup');
    if (onOpenCallback) onOpenCallback();
  };
  dataChannel.onmessage = handleDataChannelMessage;
  dataChannel.onerror = (error) => {
    console.error('DataChannel error:', error);
    updateProgress(fileId, 0, `Data channel error for ${transfers.get(fileId)?.fileName}`, 'setup');
  };
  dataChannel.onclose = () => {
    console.log('DataChannel closed');
    updateProgress(fileId, 0, `Connection closed for ${transfers.get(fileId)?.fileName}`, 'setup');
    isDownloading = false;
    processDownloadQueue();
  };

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      console.log('ICE candidate found:', e.candidate.candidate);
      ws.send(JSON.stringify({
        type: 'signal',
        targetId,
        signal: { candidate: e.candidate },
      }));
      updateProgress(fileId, 0, `Sending ICE candidates for ${transfers.get(fileId)?.fileName}...`, 'setup');
    }
  };
  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'disconnected') {
      updateProgress(fileId, 0, `Connection disconnected for ${transfers.get(fileId)?.fileName}`, 'setup');
      peerConnection.close();
      peerConnection = null;
      dataChannel = null;
      isDownloading = false;
      processDownloadQueue();
    }
  };
  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE connection state:', peerConnection.iceConnectionState);
    updateProgress(fileId, 0, `ICE connection state: ${peerConnection.iceConnectionState} for ${transfers.get(fileId)?.fileName}`, 'setup');
  };
  peerConnection.onsignalingstatechange = () => {
    console.log('Signaling state:', peerConnection.signalingState);
    updateProgress(fileId, 0, `Signaling state: ${peerConnection.signalingState} for ${transfers.get(fileId)?.fileName}`, 'setup');
  };
  peerConnection.onicecandidateerror = (e) => {
    console.error('ICE candidate error:', e.errorText, 'URL:', e.url);
    updateProgress(fileId, 0, `ICE candidate error for ${transfers.get(fileId)?.fileName}`, 'setup');
  };

  console.log('Creating offer');
  peerConnection.createOffer()
    .then(offer => {
      console.log('Offer created:', offer.sdp.substring(0, 100) + '...');
      updateProgress(fileId, 0, `Offer created for ${transfers.get(fileId)?.fileName}`, 'setup');
      return peerConnection.setLocalDescription(offer);
    })
    .then(() => {
      console.log('Local description set, sending offer to target:', targetId);
      updateProgress(fileId, 0, `Sending offer to peer for ${transfers.get(fileId)?.fileName}...`, 'setup');
      ws.send(JSON.stringify({
        type: 'signal',
        targetId,
        signal: peerConnection.localDescription,
      }));
    })
    .catch(error => {
      console.error('WebRTC setup error:', error);
      updateProgress(fileId, 0, `WebRTC setup failed for ${transfers.get(fileId)?.fileName}`, 'setup');
    });
}

function handleSignal(data) {
  console.log('Received signal from:', data.fromId, 'for target:', data.targetId);
  const fileId = Array.from(transfers.keys()).find(id => transfers.get(id).direction === 'receive');
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
    updateProgress(fileId, 0, `Received offer for ${transfers.get(fileId)?.fileName}`, 'setup');

    peerConnection.ondatachannel = (e) => {
      dataChannel = e.channel;
      dataChannel.binaryType = 'arraybuffer';
      dataChannel.onopen = () => {
        console.log('Incoming DataChannel opened');
        updateProgress(fileId, 0, `Incoming connection established for ${transfers.get(fileId)?.fileName}`, 'setup');
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
        updateProgress(fileId, 0, `Sending ICE candidates for ${transfers.get(fileId)?.fileName}...`, 'setup');
      }
    };
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'disconnected') {
        updateProgress(fileId, 0, `Connection disconnected for ${transfers.get(fileId)?.fileName}`, 'setup');
        peerConnection.close();
        peerConnection = null;
        dataChannel = null;
      }
    };

    peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        updateProgress(fileId, 0, `Remote description set for ${transfers.get(fileId)?.fileName}`, 'setup');
        while (pendingCandidates.length > 0) {
          peerConnection.addIceCandidate(new RTCIceCandidate(pendingCandidates.shift()));
        }
        return peerConnection.createAnswer();
      })
      .then(answer => {
        updateProgress(fileId, 0, `Answer created for ${transfers.get(fileId)?.fileName}`, 'setup');
        return peerConnection.setLocalDescription(answer);
      })
      .then(() => {
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: data.fromId,
          signal: peerConnection.localDescription,
        }));
        updateProgress(fileId, 0, `Sending answer to peer for ${transfers.get(fileId)?.fileName}...`, 'setup');
      })
      .catch(error => {
        console.error('Error handling offer:', error);
        updateProgress(fileId, 0, `Failed to handle offer for ${transfers.get(fileId)?.fileName}`, 'setup');
      });
  } else if (data.signal.type === 'answer') {
    if (!peerConnection) return;
    peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        updateProgress(fileId, 0, `Answer received for ${transfers.get(fileId)?.fileName}`, 'setup');
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
      updateProgress(fileId, 0, `Received ICE candidate for ${transfers.get(fileId)?.fileName}`, 'setup');
    } else {
      pendingCandidates.push(data.signal.candidate);
    }
  }
}

function handleDataChannelMessage(e) {
  if (typeof e.data === 'string') {
    const message = JSON.parse(e.data);
    console.log('Received message:', message);
    if (message.type === 'request') {
      const file = sharedFilesMap.get(message.fileName)?.file;
      if (file) sendFileWithProgress(file, message.fileId);
    } else if (message.type === 'fileSize') {
      const fileId = message.fileId || Date.now().toString();
      transfers.set(fileId, {
        fileName: message.fileName,
        totalSize: message.size || 0,
        receivedSize: 0,
        chunks: [],
        progressBarId: createProgressBar(fileId, message.fileName, 'receive'),
        direction: 'receive'
      });
      console.log(`Set totalSize for ${fileId} to ${message.size} bytes`);
      updateProgress(fileId, 0, `Receiving ${message.fileName} (0.00 KB of ${(message.size / 1024).toFixed(2)} KB)...`, 'receive');
    } else if (message.type === 'end') {
      console.log('Received end message, finalizing download');
      receiveFileWithProgress(message.fileId);
    } else if (message.type === 'stop') {
      console.log(`Received stop message for fileId: ${message.fileId}`);
      transfers.delete(message.fileId);
      const progressBar = document.getElementById(`progress-${message.fileId}`);
      if (progressBar) progressBar.remove();
      console.log(`Transfer of ${message.fileName || 'file'} stopped by sender`);
    }
  } else {
    const fileId = Array.from(transfers.keys()).find(id => transfers.get(id).direction === 'receive') || Date.now().toString();
    const transfer = transfers.get(fileId);
    if (transfer) {
      if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
        transfer.chunks.push(e.data);
        transfer.receivedSize += e.data.byteLength;
        console.log(`Received valid ArrayBuffer chunk for ${fileId}, byteLength: ${e.data.byteLength}, receivedSize: ${transfer.receivedSize}, totalSize: ${transfer.totalSize}`);
        
        const progress = transfer.totalSize > 0 ? (transfer.receivedSize / transfer.totalSize) * 100 : 0;
        updateProgress(fileId, progress, `Receiving ${transfer.fileName} (${(transfer.receivedSize / 1024).toFixed(2)} KB of ${(transfer.totalSize / 1024).toFixed(2)} KB)...`, 'receive');
      } else if (e.data instanceof Blob && e.data.size > 0) {
        transfer.chunks.push(e.data);
        transfer.receivedSize += e.data.size;
        console.log(`Received valid Blob chunk for ${fileId}, size: ${e.data.size}, receivedSize: ${transfer.receivedSize}, totalSize: ${transfer.totalSize}`);
        
        const progress = transfer.totalSize > 0 ? (transfer.receivedSize / transfer.totalSize) * 100 : 0;
        updateProgress(fileId, progress, `Receiving ${transfer.fileName} (${(transfer.receivedSize / 1024).toFixed(2)} KB of ${(transfer.totalSize / 1024).toFixed(2)} KB)...`, 'receive');
      } else {
        console.warn(`Received invalid chunk for ${fileId}, type: ${e.data?.constructor?.name || 'unknown'}, byteLength: ${e.data?.byteLength || 'undefined'}, size: ${e.data?.size || 'undefined'}, isArrayBuffer: ${e.data instanceof ArrayBuffer}, raw:`, e.data);
      }
    } else {
      console.warn(`No transfer found for chunk, fileId: ${fileId}`);
    }
  }
}

function sendFileWithProgress(file, fileId = Date.now().toString()) {
  if (!isSharing || dataChannel?.readyState !== 'open') {
    console.warn('Cannot send file: not sharing or data channel closed');
    return;
  }

  const chunkSize = 131072;
  file.arrayBuffer().then(buffer => {
    const totalSize = buffer.byteLength;
    transfers.set(fileId, {
      fileName: file.name,
      totalSize: totalSize,
      sentSize: 0,
      progressBarId: createProgressBar(fileId, file.name, 'send'),
      direction: 'send'
    });
    dataChannel.send(JSON.stringify({ type: 'fileSize', size: totalSize, fileName: file.name, fileId }));
    console.log(`Sent fileSize for ${fileId}: ${totalSize} bytes`);
    
    let offset = 0;
    updateProgress(fileId, 0, `Sending ${file.name} (0.00 KB of ${(totalSize / 1024).toFixed(2)} KB)...`, 'send');

    function sendNextChunk() {
      if (!isSharing || offset >= totalSize || dataChannel.readyState !== 'open') {
        if (offset >= totalSize) {
          dataChannel.send(JSON.stringify({ type: 'end', fileId }));
          updateProgress(fileId, 100, `Sent ${file.name}`, 'send');
        }
        return;
      }
      const chunk = buffer.slice(offset, offset + chunkSize);
      console.log(`Sending chunk for ${fileId}, offset: ${offset}, size: ${chunk.byteLength}`);
      dataChannel.send(chunk);
      offset += chunkSize;
      const transfer = transfers.get(fileId);
      if (transfer) {
        transfer.sentSize = Math.min(offset, totalSize);
        const progress = (transfer.sentSize / totalSize) * 100;
        updateProgress(fileId, progress, `Sending ${file.name} (${(transfer.sentSize / 1024).toFixed(2)} KB of ${(totalSize / 1024).toFixed(2)} KB)...`, 'send');
        setTimeout(sendNextChunk, 10);  // Set to 10 for better stability, to 0 for higher speed
      }
    }
    sendNextChunk();
  }).catch(error => {
    console.error('Error reading file buffer:', error);
    console.log('Error sending file');
    transfers.delete(fileId);
  });
}

function receiveFileWithProgress(fileId) {
  const transfer = transfers.get(fileId);
  if (!transfer || transfer.chunks.length === 0) {
    console.warn(`No valid chunks for ${fileId}, skipping download`);
    transfers.delete(fileId);
    isDownloading = false;
    processDownloadQueue();
    return;
  }

  const receivedSize = transfer.receivedSize;
  const progress = transfer.totalSize > 0 ? (receivedSize / transfer.totalSize) * 100 : 100;
  console.log(`Finalizing download for ${fileId}: receivedSize: ${receivedSize}, totalSize: ${transfer.totalSize}, progress: ${progress}%`);
  updateProgress(fileId, progress, `Finalizing ${transfer.fileName}...`, 'receive');
  
  const blob = new Blob(transfer.chunks);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = transfer.fileName || 'downloaded_file';
  a.click();
  URL.revokeObjectURL(url);

  updateProgress(fileId, 100, `Received ${transfer.fileName}`, 'receive');
  isDownloading = false;
  processDownloadQueue();
}

window.onload = registerDevice;
