// One-off / manual: builds or refreshes the local country-only geo-IP database
// used by stats.js. Run via `npm run updatedb`. Normally unnecessary after
// initial setup, since ip-location-api's ILA_AUTO_UPDATE refreshes it
// automatically (twice weekly by default) as long as the server process keeps
// running.
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
process.env.ILA_DATA_DIR = process.env.ILA_DATA_DIR || path.join(DATA_DIR, 'geoip');
process.env.ILA_TMP_DATA_DIR = process.env.ILA_TMP_DATA_DIR || path.join(DATA_DIR, 'geoip-tmp');
process.env.ILA_IP_LOCATION_DB = process.env.ILA_IP_LOCATION_DB || 'user';
// Delete the raw downloaded CSV sources after building, rather than keeping
// them around indefinitely (default 'reuse') -- the server this runs on has
// very little free disk.
process.env.ILA_DOWNLOAD_TYPE = process.env.ILA_DOWNLOAD_TYPE || 'false';
// This is a one-off manual build, not a long-running process -- don't let the
// library arm its recurring auto-update cron (which would keep this process
// alive forever instead of exiting once the build finishes).
process.env.ILA_AUTO_UPDATE = process.env.ILA_AUTO_UPDATE || 'false';

const { updateDb } = require('ip-location-api');

updateDb()
  .then(() => {
    console.log('Geo-IP database updated at', process.env.ILA_DATA_DIR);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Failed to update geo-IP database:', err);
    process.exit(1);
  });
