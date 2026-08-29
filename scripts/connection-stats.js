// Prints connection stats (last 24h and last 7 days) from data/stats.db.
// Read-only report script -- opens the DB in read-only mode so it can be run
// at any time without risk to the live server, even while the server has the
// same WAL-mode DB open for writes.
//
// Usage: node scripts/connection-stats.js  (or: npm run stats)
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'data', 'stats.db');

let db;
try {
  db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch (err) {
  console.error(`Could not open ${DB_PATH}: ${err.message}`);
  console.error('Has the server been run yet with STATS_IP_SALT set?');
  process.exit(1);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function formatDuration(ms) {
  if (ms == null) return 'active';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function report(label, windowMs) {
  const since = Date.now() - windowMs;

  const connections = db
    .prepare(
      `SELECT id, ip_hash, country, connected_at, disconnected_at
       FROM connections
       WHERE connected_at >= ?
       ORDER BY connected_at DESC`
    )
    .all(since);

  const fileShares = db
    .prepare(`SELECT connection_id, size_bytes FROM file_shares WHERE shared_at >= ?`)
    .all(since);
  const textShares = db
    .prepare(`SELECT connection_id, length FROM text_shares WHERE shared_at >= ?`)
    .all(since);

  const fileCountByConn = {};
  const fileBytesByConn = {};
  for (const f of fileShares) {
    fileCountByConn[f.connection_id] = (fileCountByConn[f.connection_id] || 0) + 1;
    fileBytesByConn[f.connection_id] = (fileBytesByConn[f.connection_id] || 0) + f.size_bytes;
  }
  const textCountByConn = {};
  for (const t of textShares) {
    textCountByConn[t.connection_id] = (textCountByConn[t.connection_id] || 0) + 1;
  }

  console.log(`\n=== ${label} (since ${formatDate(since)}) ===`);
  console.log(`Total connections: ${connections.length}`);

  const uniqueIps = new Set(connections.map((c) => c.ip_hash));
  console.log(`Unique visitors (by IP hash): ${uniqueIps.size}`);

  const byCountry = {};
  for (const c of connections) {
    const key = c.country || 'unknown';
    byCountry[key] = (byCountry[key] || 0) + 1;
  }
  const countryList = Object.entries(byCountry).sort((a, b) => b[1] - a[1]);
  console.log(`By country: ${countryList.map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);

  const totalFileBytes = fileShares.reduce((sum, f) => sum + f.size_bytes, 0);
  const totalTextChars = textShares.reduce((sum, t) => sum + t.length, 0);
  console.log(`File shares: ${fileShares.length} (${formatBytes(totalFileBytes)} total)`);
  console.log(`Text shares: ${textShares.length} (${totalTextChars} chars total)`);

  if (connections.length === 0) return;

  console.log('\nDetails (ip_hash is a salted one-way hash, not the real IP -- shown truncated just to tell repeat visitors apart):');
  const header = ['id', 'connected_at', 'duration', 'country', 'ip_hash', 'files', 'texts'];
  const widths = [6, 19, 10, 9, 12, 5, 5];
  console.log(header.map((h, i) => h.padEnd(widths[i])).join(' '));

  for (const c of connections) {
    const duration = formatDuration(c.disconnected_at ? c.disconnected_at - c.connected_at : null);
    const row = [
      String(c.id),
      formatDate(c.connected_at),
      duration,
      c.country || 'unknown',
      c.ip_hash.slice(0, 10),
      String(fileCountByConn[c.id] || 0),
      String(textCountByConn[c.id] || 0),
    ];
    console.log(row.map((v, i) => v.padEnd(widths[i])).join(' '));
  }
}

report('Last 24 hours', DAY);
report('Last 7 days', 7 * DAY);

db.close();
