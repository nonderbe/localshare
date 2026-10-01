const fs = require('fs');

const HOUR = 60 * 60 * 1000;
const CHECK_INTERVAL = HOUR;
const REPEAT_INTERVAL = 24 * HOUR;
const THRESHOLD = Number(process.env.DISK_ALERT_PERCENT) || 85;

// Same figure `df` prints in its Use% column: space root has reserved for
// itself counts as used, since nothing else can write into it.
function diskUsage(mountPath) {
  const s = fs.statfsSync(mountPath);
  const used = s.blocks - s.bfree;
  return {
    percent: Math.ceil((used / (used + s.bavail)) * 100),
    freeBytes: s.bavail * s.bsize,
  };
}

// Emails a warning when the disk this server runs on passes THRESHOLD percent,
// and again every 24 hours for as long as it stays there. The server shares a
// small disk with other software; when that disk filled up, deploys and stats
// writes failed without anything pointing at the cause.
//
// Fails open like stats.js: without mail settings it logs one warning and does
// nothing, and a failed check or failed mail is only logged.
function start({ sendMail, from, to, mountPath = '/' }) {
  if (!from || !to) {
    console.warn('disk-alert: EMAIL_USER / NOTIFY_EMAIL not set — disk space alerts are disabled');
    return;
  }

  let lastAlertAt = 0;

  function check() {
    let usage;
    try {
      usage = diskUsage(mountPath);
    } catch (err) {
      console.error('disk-alert: could not read disk usage:', err.message);
      return;
    }

    if (usage.percent < THRESHOLD) {
      lastAlertAt = 0;
      return;
    }
    if (Date.now() - lastAlertAt < REPEAT_INTERVAL) return;
    lastAlertAt = Date.now();

    const freeMb = Math.round(usage.freeBytes / 1024 / 1024);
    sendMail({
      from,
      to,
      subject: `[LocalShare] Server disk at ${usage.percent}%`,
      text: `The disk mounted at ${mountPath} is ${usage.percent}% full (${freeMb} MB free). `
        + `The alert threshold is ${THRESHOLD}%.\n\n`
        + 'To see what is using the space: du -xh --max-depth=2 / | sort -rh | head -20\n\n'
        + 'This warning repeats every 24 hours while the disk stays above the threshold.',
    }, (error) => {
      if (error) {
        console.error('disk-alert: failed to send warning email:', error.message);
        // Let the next hourly check try again instead of waiting a full day.
        lastAlertAt = 0;
      } else {
        console.log(`disk-alert: warning email sent, disk at ${usage.percent}%`);
      }
    });
  }

  check();
  setInterval(check, CHECK_INTERVAL).unref();
}

module.exports = { start, diskUsage };
