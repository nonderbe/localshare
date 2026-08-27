const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Must be set before requiring ip-location-api, which reads these at load time.
process.env.ILA_DATA_DIR = process.env.ILA_DATA_DIR || path.join(DATA_DIR, 'geoip');
process.env.ILA_TMP_DATA_DIR = process.env.ILA_TMP_DATA_DIR || path.join(DATA_DIR, 'geoip-tmp');
process.env.ILA_IP_LOCATION_DB = process.env.ILA_IP_LOCATION_DB || 'user';
process.env.ILA_SILENT = process.env.ILA_SILENT || 'true';
// Delete the raw downloaded CSV sources after each (auto-)update rather than
// keeping them around indefinitely (default 'reuse') -- disk is tight on the
// server this runs on.
process.env.ILA_DOWNLOAD_TYPE = process.env.ILA_DOWNLOAD_TYPE || 'false';

let geoLookup = null;
try {
  ({ lookup: geoLookup } = require('ip-location-api'));
} catch (err) {
  console.error('stats: failed to load ip-location-api, country lookups disabled:', err.message);
}

const STATS_IP_SALT = process.env.STATS_IP_SALT;
if (!STATS_IP_SALT) {
  console.warn('stats: STATS_IP_SALT not set — usage-stats logging is disabled');
}

let db = null;
let insertConnectionStmt, markDisconnectedStmt, insertFileShareStmt, insertTextShareStmt;

if (STATS_IP_SALT) {
  try {
    db = new DatabaseSync(path.join(DATA_DIR, 'stats.db'));
    db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS connections (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_hash         TEXT NOT NULL,
        country         TEXT,
        connected_at    INTEGER NOT NULL,
        disconnected_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_connections_ip_hash      ON connections(ip_hash);
      CREATE INDEX IF NOT EXISTS idx_connections_connected_at ON connections(connected_at);

      CREATE TABLE IF NOT EXISTS file_shares (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER REFERENCES connections(id),
        size_bytes    INTEGER NOT NULL,
        shared_at     INTEGER NOT NULL,
        source        TEXT NOT NULL DEFAULT 'live'
      );
      CREATE INDEX IF NOT EXISTS idx_file_shares_connection_id ON file_shares(connection_id);
      CREATE INDEX IF NOT EXISTS idx_file_shares_shared_at     ON file_shares(shared_at);

      CREATE TABLE IF NOT EXISTS text_shares (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER REFERENCES connections(id),
        length        INTEGER NOT NULL,
        shared_at     INTEGER NOT NULL,
        source        TEXT NOT NULL DEFAULT 'live'
      );
      CREATE INDEX IF NOT EXISTS idx_text_shares_connection_id ON text_shares(connection_id);
      CREATE INDEX IF NOT EXISTS idx_text_shares_shared_at     ON text_shares(shared_at);
    `);

    insertConnectionStmt = db.prepare(
      'INSERT INTO connections (ip_hash, country, connected_at) VALUES (?, ?, ?)'
    );
    markDisconnectedStmt = db.prepare(
      'UPDATE connections SET disconnected_at = ? WHERE id = ? AND disconnected_at IS NULL'
    );
    insertFileShareStmt = db.prepare(
      'INSERT INTO file_shares (connection_id, size_bytes, shared_at) VALUES (?, ?, ?)'
    );
    insertTextShareStmt = db.prepare(
      'INSERT INTO text_shares (connection_id, length, shared_at) VALUES (?, ?, ?)'
    );
  } catch (err) {
    console.error('stats: failed to open/migrate stats.db, usage-stats logging is disabled:', err.message);
    db = null;
  }
}

function extractIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip + STATS_IP_SALT).digest('hex');
}

function lookupCountry(ip) {
  if (!geoLookup) return null;
  try {
    return geoLookup(ip)?.country || null;
  } catch (err) {
    return null;
  }
}

function recordConnection(req) {
  if (!db) return null;
  try {
    const ip = extractIp(req);
    const ipHash = hashIp(ip);
    const country = lookupCountry(ip);
    const result = insertConnectionStmt.run(ipHash, country, Date.now());
    return Number(result.lastInsertRowid);
  } catch (err) {
    console.error('stats: failed to record connection:', err.message);
    return null;
  }
}

function markDisconnected(connRowId) {
  if (!db || connRowId == null) return;
  try {
    markDisconnectedStmt.run(Date.now(), connRowId);
  } catch (err) {
    console.error('stats: failed to mark disconnected:', err.message);
  }
}

function recordFileShare(connRowId, sizeBytes, sharedAtMs) {
  if (!db) return;
  try {
    insertFileShareStmt.run(connRowId, sizeBytes, sharedAtMs);
  } catch (err) {
    console.error('stats: failed to record file share:', err.message);
  }
}

function recordTextShare(connRowId, length, sharedAtMs) {
  if (!db) return;
  try {
    insertTextShareStmt.run(connRowId, length, sharedAtMs);
  } catch (err) {
    console.error('stats: failed to record text share:', err.message);
  }
}

module.exports = {
  recordConnection,
  markDisconnected,
  recordFileShare,
  recordTextShare,
};
