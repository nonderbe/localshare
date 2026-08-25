console.log('client.js loaded successfully');

let ws;
let myId;
let sharedFilesMap = new Map();
let isDownloading = false;
let isSharing = true;
const transfers = new Map(); // Track transfers: { fileId: { fileName, totalSize, receivedSize/sentSize, ..., progressBarId, direction } }
const downloadQueue = [];
let files = [];

// Connections to peers we're downloading FROM (we sent the offer).
const outgoingConnections = new Map(); // peerId -> { pc, dc, pendingCandidates, fileId }
// Connections to peers who are downloading FROM us (they sent the offer).
const incomingConnections = new Map(); // peerId -> { pc, dc, pendingCandidates, sendFileIds }

// Text sharing: id -> { text, ownerId, timestamp, label, length }. Full text content
// never touches the server -- only the label/length metadata does (see shareText()).
let sharedTextsMap = new Map();
let textCounter = 0;
let lastSharedTexts = [];
// Full content of others' text items we've already fetched P2P, keyed by id -- once
// present here the item is rendered in full instead of behind its label, and repeat
// copies are served from this cache instead of re-fetching.
const revealedTexts = new Map();

// Separate connection maps for text fetches, kept fully independent from the file
// transfer connections above so a text Copy never tears down an in-flight file
// download to/from the same peer (or vice versa).
const outgoingTextConnections = new Map(); // peerId -> { pc, dc, pendingCandidates, textId }
const incomingTextConnections = new Map(); // peerId -> { pc, dc, pendingCandidates }

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const hostname = window.location.hostname;
const serverUrl = `${protocol}//${hostname}`;
console.log(`WebSocket URL: ${serverUrl}`);

// Create a unique progress bar for a file transfer
function createProgressBar(fileId, fileName, direction) {
  const container = document.getElementById('progressContainer');
  const barId = `progress-${fileId}`;

  const bar = document.createElement('div');
  bar.id = barId;
  bar.className = 'progress-bar';

  const fill = document.createElement('div');
  fill.id = `${barId}-fill`;
  fill.className = 'progress-fill';

  const text = document.createElement('span');
  text.id = `${barId}-text`;
  text.className = `progress-text ${direction}`;
  text.textContent = `${direction === 'send' ? 'Sending' : 'Preparing to receive'} ${fileName}`;

  bar.append(fill, text);
  container.appendChild(bar);
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

  if (safePercentage >= 100 && direction !== 'setup') {
    setTimeout(() => {
      progressBar.remove();
      transfers.delete(fileId);
      console.log(`Removed progress bar for ${fileId}`);
    }, 1000);
  }
}

// Remove a transfer's bookkeeping and its progress bar, regardless of how it ended.
function cleanupTransfer(fileId) {
  transfers.delete(fileId);
  const progressBar = document.getElementById(`progress-${fileId}`);
  if (progressBar) progressBar.remove();
}

function closeConnectionObjects(conn) {
  try { conn.dc?.close(); } catch (err) { /* already closed */ }
  try { conn.pc?.close(); } catch (err) { /* already closed */ }
}

// Tear down an outgoing (we-are-downloading) connection. Safe to call multiple times /
// from stale event handlers: only mutates the map if it still points at this exact
// connection object, and only cleans up + requeues if this connection still owns a fileId.
function teardownOutgoing(peerId, conn) {
  closeConnectionObjects(conn);
  if (outgoingConnections.get(peerId) === conn) {
    outgoingConnections.delete(peerId);
  }
  if (conn.fileId) {
    cleanupTransfer(conn.fileId);
    conn.fileId = null;
    isDownloading = false;
    processDownloadQueue();
  }
}

// Tear down an incoming (peer-is-downloading-from-us) connection. Same safety properties.
function teardownIncoming(peerId, conn) {
  closeConnectionObjects(conn);
  if (incomingConnections.get(peerId) === conn) {
    incomingConnections.delete(peerId);
  }
  if (conn.sendFileIds && conn.sendFileIds.size > 0) {
    conn.sendFileIds.forEach(fileId => cleanupTransfer(fileId));
    conn.sendFileIds.clear();
  }
}

// Closes a text connection's data channel first, only closing the peer connection
// once that channel's own closing handshake has completed (or immediately if there's
// no channel to wait on). Closing the peer connection right away, before the data
// channel's SCTP stream-reset finishes, is what was surfacing as an RTCErrorEvent on
// the other peer's channel -- waiting for it lets both sides close cleanly.
function closeTextConnectionGracefully(conn) {
  const { pc, dc } = conn;
  if (!dc || dc.readyState === 'closed') {
    try { pc?.close(); } catch (err) { /* already closed */ }
    return;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try { pc.close(); } catch (err) { /* already closed */ }
  };
  dc.onclose = finish;
  setTimeout(finish, 2000); // safety net in case the channel never reports closed
  try {
    dc.close();
  } catch (err) {
    finish();
  }
}

function teardownOutgoingText(peerId, conn) {
  if (outgoingTextConnections.get(peerId) === conn) {
    outgoingTextConnections.delete(peerId);
  }
  closeTextConnectionGracefully(conn);
}

function teardownIncomingText(peerId, conn) {
  if (incomingTextConnections.get(peerId) === conn) {
    incomingTextConnections.delete(peerId);
  }
  closeTextConnectionGracefully(conn);
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
      const fileName = checkbox.dataset.fileName;
      const fileOwner = checkbox.dataset.ownerId;
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
      const span = document.createElement('span');
      span.textContent = file.name;
      listItem.appendChild(span);
      deviceFilesList.appendChild(listItem);
      sharedFilesMap.set(file.name, { file, ownerId: myId });
    });
    // Announce once for the whole batch, not once per file (a folder of hundreds of
    // files would otherwise re-send the full, growing file list on every iteration).
    shareFilesToNetwork();
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
    pendingChunks: [],
    pendingBytes: 0,
    blobParts: [],
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
    // Re-share all locally-owned text items on reconnect (mirrors file re-share above)
    Array.from(sharedTextsMap.entries())
      .filter(([, t]) => t.ownerId === myId)
      .forEach(([id, t]) => {
        ws.send(JSON.stringify({ type: 'shareText', id, label: t.label, length: t.length, timestamp: t.timestamp }));
      });
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    document.getElementById('deviceCount').textContent = 'Live device sync unavailable right now — you can still browse LocalShare below.';
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed:', event);
    document.getElementById('deviceCount').textContent = 'Reconnecting to nearby devices...';
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
    console.log('Processing update - Device count:', data.deviceCount, 'Files:', data.sharedFiles, 'Texts:', data.sharedTexts);
    updateDeviceCount(data.deviceCount);
    updateFileLists(data.sharedFiles);
    updateTextLists(data.sharedTexts || []);
  } else if (data.type === 'signal') {
    if (data.kind === 'text') {
      handleTextSignal(data);
    } else {
      handleSignal(data);
    }
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
      const span = document.createElement('span');
      span.textContent = file.name;
      li.appendChild(span);
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
      const span = document.createElement('span');
      span.textContent = `${file.name} (${sizeInKB} KB)`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.fileName = file.name;
      checkbox.dataset.ownerId = file.ownerId;
      li.append(span, checkbox);
      otherFilesList.appendChild(li);
      sharedFilesMap.set(file.name, { ...file, ownerId: file.ownerId });
    });
  }
}

function updateTextLists(sharedTexts) {
  lastSharedTexts = sharedTexts;
  const deviceTextsList = document.getElementById('deviceTexts');
  const otherTextsList = document.getElementById('otherTexts');

  // Update local texts (deviceTextsList) -- rendered from our own map, same pattern
  // as updateFileLists uses sharedFilesMap, so it stays correct even before the
  // server's broadcast round-trips back.
  deviceTextsList.innerHTML = '';
  const localTexts = Array.from(sharedTextsMap.entries())
    .filter(([, t]) => t.ownerId === myId)
    .map(([id, t]) => ({ id, ...t }));
  if (localTexts.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No text shared yet. Type something above to start.';
    deviceTextsList.appendChild(li);
  } else {
    localTexts.forEach(t => {
      const li = document.createElement('li');
      li.className = 'own-text-item';
      const span = document.createElement('span');
      span.className = 'text-content';
      span.textContent = t.text;
      const stopBtn = document.createElement('button');
      stopBtn.className = 'stop-share-btn';
      stopBtn.textContent = '×';
      stopBtn.title = 'Stop sharing';
      stopBtn.addEventListener('click', () => stopSharingText(t.id));
      li.append(span, stopBtn);
      deviceTextsList.appendChild(li);
    });
  }

  // Update other devices' texts (otherTextsList) -- shows just the label until the
  // user fetches the full text P2P (see requestText()), then shows it in full.
  otherTextsList.innerHTML = '';
  const otherTexts = sharedTexts.filter(t => t.ownerId !== myId);
  if (otherTexts.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No text available yet. Connect another device to see shared text.';
    otherTextsList.appendChild(li);
  } else {
    otherTexts.forEach(t => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'text-content';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn-share';
      copyBtn.textContent = 'Copy';
      const revealedText = revealedTexts.get(t.id);
      if (revealedText !== undefined) {
        span.textContent = revealedText;
        copyBtn.addEventListener('click', () => copyTextToClipboard(revealedText, copyBtn));
      } else {
        span.textContent = `${t.label} (${t.length} char${t.length === 1 ? '' : 's'})`;
        copyBtn.addEventListener('click', () => requestText(t.ownerId, t.id, copyBtn));
      }
      li.append(span, copyBtn);
      otherTextsList.appendChild(li);
    });
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

function shareText() {
  const textInput = document.getElementById('textInput');
  const text = textInput.value;
  if (!text.trim()) return;

  textCounter += 1;
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const label = `Message ${textCounter}`;
  const timestamp = Date.now();

  sharedTextsMap.set(id, { text, ownerId: myId, timestamp, label, length: text.length });
  textInput.value = '';

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'shareText', id, label, length: text.length, timestamp }));
    console.log('Shared text:', id, label);
  } else {
    console.error('WebSocket not open, text will be re-shared on reconnect');
  }
  updateTextLists(lastSharedTexts);
}

function stopSharingText(id) {
  sharedTextsMap.delete(id);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stopSharingText', id }));
  }
  updateTextLists(lastSharedTexts.filter(t => t.id !== id));
}

function shareFiles() {
  console.log('shareFiles() called');
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  const files = Array.from(fileInput.files).concat(Array.from(folderInput.files || []));
  files.forEach(file => {
    sharedFilesMap.set(file.name, { file, ownerId: myId });
    const listItem = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = file.name;
    listItem.appendChild(span);
    document.getElementById('deviceFiles').appendChild(listItem);
  });
  shareFilesToNetwork();
}

function stopSharing() {
  isSharing = false;
  sharedFilesMap.clear();
  document.getElementById('deviceFiles').innerHTML = '';
  console.log('Stopped sharing, notifying peers');

  // Cancel every in-flight send, on every incoming connection, and notify each peer.
  for (const [, conn] of incomingConnections) {
    if (!conn.sendFileIds || conn.sendFileIds.size === 0) continue;
    conn.sendFileIds.forEach(fileId => {
      const transfer = transfers.get(fileId);
      if (conn.dc?.readyState === 'open') {
        conn.dc.send(JSON.stringify({ type: 'stop', fileId, fileName: transfer?.fileName }));
      }
      cleanupTransfer(fileId);
    });
    conn.sendFileIds.clear();
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stopSharing' }));
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

  // Replace any stale/previous connection to this specific peer. This never touches
  // connections to other peers, so an unrelated transfer elsewhere in the swarm is
  // no longer collateral damage.
  const stale = outgoingConnections.get(ownerId);
  if (stale) teardownOutgoing(ownerId, stale);

  updateProgress(fileId, 0, `Creating WebRTC offer for ${fileName}...`, 'setup');

  let pc;
  try {
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ]
    });
    console.log('RTCPeerConnection created');
  } catch (error) {
    console.error('Error creating RTCPeerConnection:', error);
    updateProgress(fileId, 0, `Failed to initialize WebRTC for ${fileName}`, 'setup');
    cleanupTransfer(fileId);
    isDownloading = false;
    processDownloadQueue();
    return;
  }

  const conn = { pc, dc: null, pendingCandidates: [], fileId };
  outgoingConnections.set(ownerId, conn);

  const dc = pc.createDataChannel('fileTransfer', { binaryType: 'arraybuffer' });
  conn.dc = dc;
  console.log('DataChannel created with binaryType: arraybuffer');

  dc.onopen = () => {
    console.log('DataChannel opened');
    updateProgress(fileId, 0, `Connection established for ${fileName}`, 'setup');
    if (dc.readyState === 'open') {
      updateProgress(fileId, 0, `Requesting ${fileName} from peer...`, 'setup');
      dc.send(JSON.stringify({ type: 'request', fileName, fileId }));
    }
  };
  dc.onmessage = (e) => handleDataChannelMessage(e, conn, ownerId);
  dc.onerror = (error) => {
    console.error('DataChannel error:', error);
    updateProgress(fileId, 0, `Data channel error for ${fileName}`, 'setup');
  };
  dc.onclose = () => {
    console.log('DataChannel closed');
    updateProgress(fileId, 0, `Connection closed for ${fileName}`, 'setup');
    teardownOutgoing(ownerId, conn);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      console.log('ICE candidate found:', e.candidate.candidate);
      ws.send(JSON.stringify({
        type: 'signal',
        targetId: ownerId,
        signal: { candidate: e.candidate },
      }));
      updateProgress(fileId, 0, `Sending ICE candidates for ${fileName}...`, 'setup');
    }
  };
  pc.onconnectionstatechange = () => {
    console.log('Connection state:', pc.connectionState);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      updateProgress(fileId, 0, `Connection disconnected for ${fileName}`, 'setup');
      teardownOutgoing(ownerId, conn);
    }
  };
  pc.oniceconnectionstatechange = () => {
    console.log('ICE connection state:', pc.iceConnectionState);
    updateProgress(fileId, 0, `ICE connection state: ${pc.iceConnectionState} for ${fileName}`, 'setup');
  };
  pc.onsignalingstatechange = () => {
    console.log('Signaling state:', pc.signalingState);
    updateProgress(fileId, 0, `Signaling state: ${pc.signalingState} for ${fileName}`, 'setup');
  };
  pc.onicecandidateerror = (e) => {
    console.error('ICE candidate error:', e.errorText, 'URL:', e.url);
    updateProgress(fileId, 0, `ICE candidate error for ${fileName}`, 'setup');
  };

  console.log('Creating offer');
  pc.createOffer()
    .then(offer => {
      console.log('Offer created:', offer.sdp.substring(0, 100) + '...');
      updateProgress(fileId, 0, `Offer created for ${fileName}`, 'setup');
      return pc.setLocalDescription(offer);
    })
    .then(() => {
      console.log('Local description set, sending offer to target:', ownerId);
      updateProgress(fileId, 0, `Sending offer to peer for ${fileName}...`, 'setup');
      ws.send(JSON.stringify({
        type: 'signal',
        targetId: ownerId,
        signal: pc.localDescription,
      }));
    })
    .catch(error => {
      console.error('WebRTC setup error:', error);
      updateProgress(fileId, 0, `WebRTC setup failed for ${fileName}`, 'setup');
      teardownOutgoing(ownerId, conn);
    });
}

// Fetches one shared text item's full content P2P from its owner, kept deliberately
// separate from requestFile()'s chunked transfer protocol/connections above -- text
// is small and single-shot, and this way a Copy click can never interfere with an
// in-flight file transfer to/from the same peer.
function requestText(ownerId, textId, button) {
  console.log('requestText called - ownerId:', ownerId, 'textId:', textId);

  const stale = outgoingTextConnections.get(ownerId);
  if (stale) teardownOutgoingText(ownerId, stale);

  let pc;
  try {
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ]
    });
  } catch (error) {
    console.error('Error creating RTCPeerConnection for text:', error);
    flashButton(button, 'Error');
    return;
  }

  const conn = { pc, dc: null, pendingCandidates: [], textId };
  outgoingTextConnections.set(ownerId, conn);

  const dc = pc.createDataChannel('textTransfer');
  conn.dc = dc;

  if (button) {
    button.disabled = true;
    button.textContent = 'Copying...';
  }

  dc.onopen = () => {
    if (dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'requestText', textId }));
    }
  };
  dc.onmessage = (e) => handleTextDataChannelMessage(e, conn, ownerId, button);
  dc.onerror = (error) => {
    console.error('Text data channel error:', error);
    flashButton(button, 'Error');
  };
  dc.onclose = () => teardownOutgoingText(ownerId, conn);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({
        type: 'signal',
        targetId: ownerId,
        kind: 'text',
        signal: { candidate: e.candidate },
      }));
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      teardownOutgoingText(ownerId, conn);
    }
  };

  pc.createOffer()
    .then(offer => pc.setLocalDescription(offer))
    .then(() => {
      ws.send(JSON.stringify({
        type: 'signal',
        targetId: ownerId,
        kind: 'text',
        signal: pc.localDescription,
      }));
    })
    .catch(error => {
      console.error('WebRTC setup error for text:', error);
      flashButton(button, 'Error');
      teardownOutgoingText(ownerId, conn);
    });
}

function handleTextDataChannelMessage(e, conn, peerId, button) {
  const message = JSON.parse(e.data);
  if (message.type === 'requestText') {
    const entry = sharedTextsMap.get(message.textId);
    if (entry && entry.ownerId === myId) {
      conn.dc.send(JSON.stringify({ type: 'textData', textId: message.textId, text: entry.text }));
    } else {
      conn.dc.send(JSON.stringify({ type: 'textUnavailable', textId: message.textId }));
    }
  } else if (message.type === 'textData') {
    revealedTexts.set(message.textId, message.text);
    copyTextToClipboard(message.text, button);
    // Re-render once the copy confirmation has had time to show, swapping the item
    // over to its full-text (revealed) presentation.
    setTimeout(() => updateTextLists(lastSharedTexts), 1500);
    teardownOutgoingText(peerId, conn);
  } else if (message.type === 'textUnavailable') {
    flashButton(button, 'Unavailable');
    teardownOutgoingText(peerId, conn);
  }
}

async function copyTextToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    flashButton(button, 'Copied!');
  } catch (error) {
    console.error('Clipboard write failed:', error);
    flashButton(button, 'Copy failed');
  }
}

function flashButton(button, message) {
  if (!button) return;
  const original = 'Copy';
  button.textContent = message;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1500);
}

function handleTextSignal(data) {
  console.log('Received text signal from:', data.fromId);
  const peerId = data.fromId;

  if (data.signal.type === 'offer') {
    const stalePrev = incomingTextConnections.get(peerId);
    if (stalePrev) teardownIncomingText(peerId, stalePrev);

    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: `turn:${hostname}:3478`, username: 'localshare', credential: 'fbc7d1ec0a39eb804d78c8f7cf53bf7fa5d92dc0' }
        ]
      });
    } catch (error) {
      console.error('Error creating RTCPeerConnection for incoming text offer:', error);
      return;
    }

    const conn = { pc, dc: null, pendingCandidates: [] };
    incomingTextConnections.set(peerId, conn);

    pc.ondatachannel = (e) => {
      conn.dc = e.channel;
      conn.dc.onmessage = (e2) => handleTextDataChannelMessage(e2, conn, peerId);
      conn.dc.onerror = (error) => console.error('Incoming text data channel error:', error);
      conn.dc.onclose = () => teardownIncomingText(peerId, conn);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: peerId,
          kind: 'text',
          signal: { candidate: e.candidate },
        }));
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        teardownIncomingText(peerId, conn);
      }
    };

    pc.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        conn.pendingCandidates.forEach(candidate => pc.addIceCandidate(new RTCIceCandidate(candidate)));
        conn.pendingCandidates = [];
        return pc.createAnswer();
      })
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: peerId,
          kind: 'text',
          signal: pc.localDescription,
        }));
      })
      .catch(error => {
        console.error('Error handling text offer:', error);
        teardownIncomingText(peerId, conn);
      });

  } else if (data.signal.type === 'answer') {
    const conn = outgoingTextConnections.get(peerId);
    if (!conn) return;
    conn.pc.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        conn.pendingCandidates.forEach(candidate => conn.pc.addIceCandidate(new RTCIceCandidate(candidate)));
        conn.pendingCandidates = [];
      })
      .catch(error => console.error('Error handling text answer:', error));

  } else if (data.signal.candidate) {
    const conn = outgoingTextConnections.get(peerId) || incomingTextConnections.get(peerId);
    if (!conn) return;
    if (conn.pc.remoteDescription) {
      conn.pc.addIceCandidate(new RTCIceCandidate(data.signal.candidate))
        .catch(error => console.error('Error adding text ICE candidate:', error));
    } else {
      conn.pendingCandidates.push(data.signal.candidate);
    }
  }
}

function handleSignal(data) {
  console.log('Received signal from:', data.fromId);
  const peerId = data.fromId;

  if (data.signal.type === 'offer') {
    // Replace any stale/previous incoming connection from this specific peer only.
    const stalePrev = incomingConnections.get(peerId);
    if (stalePrev) teardownIncoming(peerId, stalePrev);

    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: `turn:${hostname}:3478`, username: 'localshare', credential: 'fbc7d1ec0a39eb804d78c8f7cf53bf7fa5d92dc0' }
        ]
      });
    } catch (error) {
      console.error('Error creating RTCPeerConnection for incoming offer:', error);
      return;
    }

    const conn = { pc, dc: null, pendingCandidates: [], sendFileIds: new Set() };
    incomingConnections.set(peerId, conn);

    pc.ondatachannel = (e) => {
      conn.dc = e.channel;
      conn.dc.binaryType = 'arraybuffer';
      conn.dc.onopen = () => {
        console.log('Incoming DataChannel opened');
      };
      conn.dc.onmessage = (e2) => handleDataChannelMessage(e2, conn, peerId);
      conn.dc.onerror = (error) => console.error('Incoming DataChannel error:', error);
      conn.dc.onclose = () => {
        console.log('Incoming DataChannel closed');
        teardownIncoming(peerId, conn);
      };
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: peerId,
          signal: { candidate: e.candidate },
        }));
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        teardownIncoming(peerId, conn);
      }
    };

    pc.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        conn.pendingCandidates.forEach(candidate => pc.addIceCandidate(new RTCIceCandidate(candidate)));
        conn.pendingCandidates = [];
        return pc.createAnswer();
      })
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        ws.send(JSON.stringify({
          type: 'signal',
          targetId: peerId,
          signal: pc.localDescription,
        }));
      })
      .catch(error => {
        console.error('Error handling offer:', error);
        teardownIncoming(peerId, conn);
      });

  } else if (data.signal.type === 'answer') {
    const conn = outgoingConnections.get(peerId);
    if (!conn) return;
    conn.pc.setRemoteDescription(new RTCSessionDescription(data.signal))
      .then(() => {
        conn.pendingCandidates.forEach(candidate => conn.pc.addIceCandidate(new RTCIceCandidate(candidate)));
        conn.pendingCandidates = [];
      })
      .catch(error => console.error('Error handling answer:', error));

  } else if (data.signal.candidate) {
    // A candidate could belong to either an outgoing or incoming negotiation with this
    // peer; in the (common) case only one exists. If both exist at once -- this peer is
    // simultaneously downloading from us AND we're downloading from them -- candidates
    // may be misrouted between the two; that narrow case can cause one of the two
    // transfers to fail ICE and retry, but no longer corrupts unrelated peers' transfers.
    const conn = outgoingConnections.get(peerId) || incomingConnections.get(peerId);
    if (!conn) return;
    if (conn.pc.remoteDescription) {
      conn.pc.addIceCandidate(new RTCIceCandidate(data.signal.candidate))
        .catch(error => console.error('Error adding ICE candidate:', error));
    } else {
      conn.pendingCandidates.push(data.signal.candidate);
    }
  }
}

function handleDataChannelMessage(e, conn, peerId) {
  if (typeof e.data === 'string') {
    const message = JSON.parse(e.data);
    console.log('Received message:', message);
    if (message.type === 'request') {
      const file = sharedFilesMap.get(message.fileName)?.file;
      if (file) sendFileWithProgress(file, message.fileId, conn);
    } else if (message.type === 'fileSize') {
      const fileId = message.fileId;
      let existing = transfers.get(fileId);
      if (!existing) {
        existing = {
          fileName: message.fileName,
          totalSize: 0,
          receivedSize: 0,
          pendingChunks: [],
          pendingBytes: 0,
          blobParts: [],
          progressBarId: createProgressBar(fileId, message.fileName, 'receive'),
          direction: 'receive'
        };
        transfers.set(fileId, existing);
      }
      existing.totalSize = message.size || 0;
      existing.fileName = message.fileName;
      console.log(`Set totalSize for ${fileId} to ${message.size} bytes`);
      updateProgress(fileId, 0, `Receiving ${message.fileName} (0.00 KB of ${(message.size / 1024).toFixed(2)} KB)...`, 'receive');
    } else if (message.type === 'end') {
      console.log('Received end message, finalizing download');
      receiveFileWithProgress(message.fileId); // may synchronously start the next queued download
      conn.fileId = null;
      closeConnectionObjects(conn);
      if (outgoingConnections.get(peerId) === conn) {
        outgoingConnections.delete(peerId);
      }
    } else if (message.type === 'stop') {
      console.log(`Received stop message for fileId: ${message.fileId}`);
      cleanupTransfer(message.fileId);
      console.log(`Transfer of ${message.fileName || 'file'} stopped by sender`);
      if (conn.fileId === message.fileId) {
        conn.fileId = null;
        isDownloading = false;
        processDownloadQueue();
      }
    }
  } else {
    // Routed via this specific connection's current fileId -- not a global search over
    // every in-flight transfer -- so a stale/orphaned entry from an earlier failed
    // transfer can never intercept bytes meant for the current one.
    const fileId = conn.fileId;
    const transfer = fileId ? transfers.get(fileId) : undefined;
    if (transfer) {
      let byteLength = 0;
      if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
        byteLength = e.data.byteLength;
      } else if (e.data instanceof Blob && e.data.size > 0) {
        byteLength = e.data.size;
      } else {
        console.warn(`Received invalid chunk for ${fileId}, type: ${e.data?.constructor?.name || 'unknown'}`);
        return;
      }
      transfer.pendingChunks.push(e.data);
      transfer.pendingBytes += byteLength;
      transfer.receivedSize += byteLength;

      // Periodically coalesce raw chunks into a Blob so peak memory stays bounded
      // instead of holding the whole file as an ever-growing array of ArrayBuffers --
      // the thing that OOMs a tab on a memory-constrained device for large files.
      const COALESCE_THRESHOLD = 4 * 1024 * 1024; // 4 MB
      if (transfer.pendingBytes >= COALESCE_THRESHOLD) {
        transfer.blobParts.push(new Blob(transfer.pendingChunks));
        transfer.pendingChunks = [];
        transfer.pendingBytes = 0;
      }

      console.log(`Received chunk for ${fileId}, byteLength: ${byteLength}, receivedSize: ${transfer.receivedSize}, totalSize: ${transfer.totalSize}`);
      const progress = transfer.totalSize > 0 ? (transfer.receivedSize / transfer.totalSize) * 100 : 0;
      updateProgress(fileId, progress, `Receiving ${transfer.fileName} (${(transfer.receivedSize / 1024).toFixed(2)} KB of ${(transfer.totalSize / 1024).toFixed(2)} KB)...`, 'receive');
    } else {
      console.warn(`No active transfer for chunk from peer ${peerId} (fileId: ${fileId})`);
    }
  }
}

async function sendFileWithProgress(file, fileId, conn) {
  if (!isSharing || conn.dc?.readyState !== 'open') {
    console.warn('Cannot send file: not sharing or data channel closed');
    return;
  }

  const CHUNK_SIZE = 65536;       // 64 KB per chunk
  const HIGH_WATERMARK = 1048576; // pause sending when buffer exceeds 1 MB
  const LOW_WATERMARK = 262144;   // resume when buffer drains to 256 KB

  const totalSize = file.size;
  let offset = 0;
  let paused = false;

  conn.sendFileIds.add(fileId);
  transfers.set(fileId, {
    fileName: file.name,
    totalSize,
    sentSize: 0,
    progressBarId: createProgressBar(fileId, file.name, 'send'),
    direction: 'send'
  });

  conn.dc.send(JSON.stringify({ type: 'fileSize', size: totalSize, fileName: file.name, fileId }));
  console.log(`Sent fileSize for ${fileId}: ${totalSize} bytes`);
  conn.dc.bufferedAmountLowThreshold = LOW_WATERMARK;
  updateProgress(fileId, 0, `Sending ${file.name} (0.00 KB of ${(totalSize / 1024).toFixed(2)} KB)...`, 'send');

  async function pump() {
    while (offset < totalSize) {
      if (!isSharing || conn.dc.readyState !== 'open') {
        conn.sendFileIds.delete(fileId);
        cleanupTransfer(fileId);
        return;
      }

      if (conn.dc.bufferedAmount >= HIGH_WATERMARK) {
        paused = true;
        return; // onbufferedamountlow will restart pump()
      }

      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      let chunk;
      try {
        chunk = await file.slice(offset, end).arrayBuffer();
        conn.dc.send(chunk);
      } catch (err) {
        console.error(`Send error for ${fileId}:`, err);
        conn.sendFileIds.delete(fileId);
        cleanupTransfer(fileId);
        return;
      }

      offset = end;
      const transfer = transfers.get(fileId);
      if (transfer) {
        transfer.sentSize = offset;
        const progress = (offset / totalSize) * 100;
        updateProgress(fileId, progress, `Sending ${file.name} (${(offset / 1024).toFixed(2)} KB of ${(totalSize / 1024).toFixed(2)} KB)...`, 'send');
      }
    }

    conn.dc.onbufferedamountlow = null;
    conn.dc.send(JSON.stringify({ type: 'end', fileId }));
    updateProgress(fileId, 100, `Sent ${file.name}`, 'send');
    conn.sendFileIds.delete(fileId);
  }

  conn.dc.onbufferedamountlow = () => {
    if (paused) {
      paused = false;
      pump();
    }
  };

  pump();
}

function receiveFileWithProgress(fileId) {
  const transfer = transfers.get(fileId);
  if (!transfer || transfer.receivedSize === 0) {
    console.warn(`No valid chunks for ${fileId}, skipping download`);
    transfers.delete(fileId);
    isDownloading = false;
    processDownloadQueue();
    return;
  }

  if (transfer.pendingChunks.length > 0) {
    transfer.blobParts.push(new Blob(transfer.pendingChunks));
    transfer.pendingChunks = [];
    transfer.pendingBytes = 0;
  }

  const receivedSize = transfer.receivedSize;
  const progress = transfer.totalSize > 0 ? (receivedSize / transfer.totalSize) * 100 : 100;
  console.log(`Finalizing download for ${fileId}: receivedSize: ${receivedSize}, totalSize: ${transfer.totalSize}, progress: ${progress}%`);
  updateProgress(fileId, progress, `Finalizing ${transfer.fileName}...`, 'receive');

  const blob = new Blob(transfer.blobParts);
  transfer.blobParts = []; // release references so they can be GC'd once the download starts
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
