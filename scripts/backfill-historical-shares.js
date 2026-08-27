// One-off, manually-run script: extracts historical file/text share events from
// the pm2 out-log (plain console.log/util.inspect dumps, NOT JSON) and inserts
// them into the usage-stats DB as source='backfill' rows.
//
// Deliberately does NOT use eval/Function/vm to parse log content — filenames
// in this log are years of real, untrusted end-user input. Instead it uses a
// hand-written balanced-brace scanner plus targeted field regexes.
//
// Cannot backfill `connections` rows: no IP was ever logged historically, and
// plain console.log lines carry no wall-clock timestamp of their own.
//
// Usage:
//   node scripts/backfill-historical-shares.js <path-to-pm2-out-log> [--db=path] [--force]

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function parseArgs(argv) {
  const args = { logPath: null, dbPath: path.join(__dirname, '..', 'data', 'stats.db'), force: false };
  for (const arg of argv) {
    if (arg === '--force') args.force = true;
    else if (arg.startsWith('--db=')) args.dbPath = arg.slice('--db='.length);
    else if (!args.logPath) args.logPath = arg;
  }
  if (!args.logPath) {
    console.error('Usage: node scripts/backfill-historical-shares.js <path-to-pm2-out-log> [--db=path] [--force]');
    process.exit(1);
  }
  return args;
}

// Scans forward from `startIndex` (which must point at a '{' or '[') and
// returns the substring up to and including its matching close bracket,
// tracking quoted-string contents (with backslash-escapes) so that braces or
// brackets embedded inside a real filename can never miscount nesting depth.
// Returns null if the block is truncated/unterminated.
function findBalancedBlock(text, startIndex) {
  let depth = 0;
  let inString = null;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

function extractNumber(block, field) {
  const m = block.match(new RegExp(field + ':\\s*(\\d+)'));
  return m ? Number(m[1]) : null;
}

// Returns the raw, still-escaped matched substring (including its quote
// chars) for use as an in-memory dedupe key only. Never unescaped, stored, or
// displayed — two identical source filenames always produce identical
// substrings here, which is all correctness requires.
function extractNameKey(block) {
  const m = block.match(/name:\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/);
  return m ? m[0] : null;
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS connections (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_hash         TEXT NOT NULL,
      country         TEXT,
      connected_at    INTEGER NOT NULL,
      disconnected_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS file_shares (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER REFERENCES connections(id),
      size_bytes    INTEGER NOT NULL,
      shared_at     INTEGER NOT NULL,
      source        TEXT NOT NULL DEFAULT 'live'
    );

    CREATE TABLE IF NOT EXISTS text_shares (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER REFERENCES connections(id),
      length        INTEGER NOT NULL,
      shared_at     INTEGER NOT NULL,
      source        TEXT NOT NULL DEFAULT 'live'
    );
  `);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const logText = fs.readFileSync(args.logPath, 'utf8');

  const db = new DatabaseSync(args.dbPath);
  ensureSchema(db);

  const existingBackfill = db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM file_shares WHERE source='backfill') + " +
      "(SELECT COUNT(*) FROM text_shares WHERE source='backfill') AS n"
    )
    .get().n;

  if (existingBackfill > 0) {
    if (!args.force) {
      console.error(
        `Found ${existingBackfill} existing backfilled rows in ${args.dbPath}. ` +
        `Re-run with --force to discard and replace them.`
      );
      process.exit(1);
    }
    db.exec("DELETE FROM file_shares WHERE source='backfill'");
    db.exec("DELETE FROM text_shares WHERE source='backfill'");
    console.log('--force: cleared previous backfill rows.');
  }

  const insertFileShare = db.prepare(
    "INSERT INTO file_shares (connection_id, size_bytes, shared_at, source) VALUES (NULL, ?, ?, 'backfill')"
  );
  const insertTextShare = db.prepare(
    "INSERT INTO text_shares (connection_id, length, shared_at, source) VALUES (NULL, ?, ?, 'backfill')"
  );

  const headerRe = /Received message from (\S+) :\s*/g;
  const seenFilesByClient = new Map(); // clientId -> Set<rawNameKey>

  const messagesParsed = { share: 0, shareText: 0 };
  const rowsInserted = { file: 0, text: 0 };
  let parseErrors = 0;

  let match;
  while ((match = headerRe.exec(logText)) !== null) {
    const clientId = match[1];
    let blockStart = headerRe.lastIndex;
    if (logText[blockStart] !== '{') {
      // Defensive fallback in case formatting ever varies unexpectedly.
      const found = logText.indexOf('{', blockStart);
      if (found === -1 || found > blockStart + 100) continue;
      blockStart = found;
    }

    try {
      const block = findBalancedBlock(logText, blockStart);
      if (!block) { parseErrors++; continue; }
      headerRe.lastIndex = blockStart + block.length;

      const typeMatch = block.match(/type:\s*'(\w+)'/);
      const type = typeMatch ? typeMatch[1] : null;

      if (type === 'share') {
        messagesParsed.share++;
        const filesIdx = block.indexOf('files:');
        if (filesIdx === -1) continue;
        const arrStart = block.indexOf('[', filesIdx);
        if (arrStart === -1) continue;
        const arrBlock = findBalancedBlock(block, arrStart);
        if (!arrBlock) { parseErrors++; continue; }

        let idx = 0;
        for (;;) {
          const objStart = arrBlock.indexOf('{', idx);
          if (objStart === -1) break;
          const objBlock = findBalancedBlock(arrBlock, objStart);
          if (!objBlock) { parseErrors++; break; }
          idx = objStart + objBlock.length;

          const size = extractNumber(objBlock, 'size');
          const timestamp = extractNumber(objBlock, 'timestamp');
          const nameKey = extractNameKey(objBlock);
          if (size == null || timestamp == null || nameKey == null) { parseErrors++; continue; }

          let seen = seenFilesByClient.get(clientId);
          if (!seen) { seen = new Set(); seenFilesByClient.set(clientId, seen); }
          if (seen.has(nameKey)) continue; // resend of an already-known file for this session
          seen.add(nameKey);

          insertFileShare.run(size, timestamp);
          rowsInserted.file++;
        }
      } else if (type === 'shareText') {
        messagesParsed.shareText++;
        const length = extractNumber(block, 'length');
        const timestamp = extractNumber(block, 'timestamp');
        if (length == null || timestamp == null) { parseErrors++; continue; }
        insertTextShare.run(length, timestamp);
        rowsInserted.text++;
      }
      // Other message types (register, stopSharing*, signal, ...) are ignored.
    } catch (err) {
      parseErrors++;
    }
  }

  console.log('Backfill summary:');
  console.log(`  share messages parsed:      ${messagesParsed.share}`);
  console.log(`  shareText messages parsed:  ${messagesParsed.shareText}`);
  console.log(`  file_shares rows inserted:  ${rowsInserted.file} (after per-session dedupe)`);
  console.log(`  text_shares rows inserted:  ${rowsInserted.text}`);
  console.log(`  parse errors:               ${parseErrors}`);
  console.log('Note: backfilled rows have no connection_id / IP / country — that data was never logged historically.');
}

main();
