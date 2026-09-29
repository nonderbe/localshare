const net = require('net');
const crypto = require('crypto');

// Devices are grouped by "network key": the exact address for IPv4 (a home
// router shares one public address), or the /64 prefix for IPv6 (the ISP
// hands each household a /64 and every device picks its own address out of
// it). Anything that doesn't parse as an IP yields null and is never grouped
// with anyone (fail closed).

// Expands an IPv6 address into 8 lowercase, zero-padded groups, or null.
function expandV6(ip) {
  if (!net.isIPv6(ip)) return null;
  let head = ip;
  let tail = [];
  // Embedded IPv4 in the last 32 bits, e.g. ::ffff:1.2.3.4
  const v4Match = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const octets = v4Match[2].split('.').map(Number);
    head = v4Match[1].endsWith('::') ? v4Match[1] : v4Match[1].slice(0, -1);
    tail = [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ];
  }
  let groups;
  if (head.includes('::')) {
    const [left, right] = head.split('::');
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = [...(right ? right.split(':') : []), ...tail];
    const missing = 8 - leftGroups.length - rightGroups.length;
    groups = [...leftGroups, ...Array(missing).fill('0'), ...rightGroups];
  } else {
    groups = [...head.split(':'), ...tail];
  }
  if (groups.length !== 8) return null;
  return groups.map(g => g.toLowerCase().padStart(4, '0'));
}

// Parses a client address (or a user-typed one, which may carry brackets,
// a zone id or a /prefix-length suffix) into its network.
function parseNetwork(raw) {
  if (typeof raw !== 'string') return null;
  const ip = raw.trim().replace(/^\[|\]$/g, '').replace(/\/\d{1,3}$/, '').replace(/%.*$/, '');
  if (net.isIPv4(ip)) {
    return { key: ip, family: 'IPv4' };
  }
  const groups = expandV6(ip);
  if (!groups) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is really an IPv4 client.
  if (groups.slice(0, 5).every(g => g === '0000') && groups[5] === 'ffff') {
    const n = parseInt(groups[6] + groups[7], 16);
    return { key: [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), family: 'IPv4' };
  }
  return { key: groups.slice(0, 4).join(':'), family: 'IPv6' };
}

// Human-readable forms of a network key: the full one for the panel, and a
// short one for the compact chip.
function describeNetwork(key) {
  if (!key.includes(':')) {
    return { key, family: 'IPv4', display: key, short: key };
  }
  const groups = key.split(':').map(g => g.replace(/^0+(?=.)/, ''));
  return {
    key,
    family: 'IPv6',
    display: `${groups.join(':')}::/64`,
    short: `${groups[0]}:…:${groups[3]}`,
  };
}

// A link joins one IPv6 network (a /64, which belongs to a single
// household) to one specific device, identified by a random token that only
// that device knows. It never joins a whole IPv4 address: carriers often put
// many unrelated households behind one shared IPv4 address (CGNAT/DS-Lite),
// and extending a network to all of them would expose it to strangers.
// A link exists only after a device on the IPv6 network approves the
// device's request, and expires after linkTtl. It also only applies while
// the device is still on the network it asked from (deviceKey), so a phone
// that leaves home doesn't keep seeing the household from elsewhere.
function createLinkStore({ linkTtl, requestTtl, maxRequestsPerTarget, maxRequestsPerDevice, maxRequestsPerSource, maxRequests }) {
  const links = new Map(); // linkId -> { networkKey, deviceToken, deviceKey, expiresAt }
  const requests = new Map(); // requestId -> { deviceToken, fromKey, toKey, expiresAt }

  const findLink = (networkKey, deviceToken, now) => {
    for (const [id, link] of links) {
      if (link.networkKey === networkKey && link.deviceToken === deviceToken && link.expiresAt > now) {
        return { id, ...link };
      }
    }
    return null;
  };

  return {
    isLinked(networkKey, deviceToken, deviceKey, now) {
      if (!networkKey || !deviceToken || !deviceKey) return false;
      const link = findLink(networkKey, deviceToken, now);
      return !!link && link.deviceKey === deviceKey;
    },

    // Live links involving this network or this device.
    linksFor(networkKey, deviceToken, now) {
      return [...links]
        .filter(([, l]) => l.expiresAt > now
          && ((networkKey && l.networkKey === networkKey) || (deviceToken && l.deviceToken === deviceToken)))
        .map(([id, l]) => ({ id, ...l }));
    },

    addLink(networkKey, deviceToken, deviceKey, now) {
      const existing = findLink(networkKey, deviceToken, now);
      if (existing) links.delete(existing.id);
      links.set(crypto.randomUUID(), { networkKey, deviceToken, deviceKey, expiresAt: now + linkTtl });
    },

    // Only a party to the link (a device on its network, or the linked
    // device itself) may remove it.
    removeLink(id, networkKey, deviceToken) {
      const link = links.get(id);
      if (!link) return false;
      const isParty = (networkKey && link.networkKey === networkKey) || (deviceToken && link.deviceToken === deviceToken);
      return isParty ? links.delete(id) : false;
    },

    // Returns a status: 'ok', 'source-limit' (this device, or its network as
    // a whole, already has too many requests pending) or 'full'. Limits are
    // mainly per device, since one IPv4 address may be shared by many
    // unrelated households who shouldn't be able to crowd each other out. A repeated request from the
    // same device to the same network refreshes the existing one instead of
    // stacking duplicate banners.
    addRequest({ deviceToken, fromKey, toKey }, now) {
      for (const [id, request] of requests) {
        if (request.deviceToken === deviceToken && request.toKey === toKey) {
          // Re-insert so it counts as the newest request again.
          requests.delete(id);
          requests.set(id, { ...request, fromKey, expiresAt: now + requestTtl });
          return 'ok';
        }
      }
      const live = [...requests.values()].filter(r => r.expiresAt > now);
      if (live.filter(r => r.deviceToken === deviceToken).length >= maxRequestsPerDevice) return 'source-limit';
      if (live.filter(r => r.fromKey === fromKey).length >= maxRequestsPerSource) return 'source-limit';
      const forTarget = [...requests].filter(([, r]) => r.toKey === toKey);
      if (forTarget.length >= maxRequestsPerTarget) {
        // Drop the one closest to expiring.
        forTarget.sort(([, a], [, b]) => a.expiresAt - b.expiresAt);
        requests.delete(forTarget[0][0]);
      } else if (requests.size >= maxRequests) {
        return 'full';
      }
      requests.set(crypto.randomUUID(), { deviceToken, fromKey, toKey, expiresAt: now + requestTtl });
      return 'ok';
    },

    requestsFor(toKey, now) {
      return [...requests]
        .filter(([, r]) => r.toKey === toKey && r.expiresAt > now)
        .map(([id, r]) => ({ id, fromKey: r.fromKey, expiresAt: r.expiresAt }));
    },

    // Removes and returns a request, but only to a device on its target
    // network; anyone else gets null and the request stays pending.
    takeRequest(id, toKey, now) {
      const request = requests.get(id);
      if (!request || request.toKey !== toKey || request.expiresAt <= now) return null;
      requests.delete(id);
      return request;
    },

    // Drops expired links and requests; returns whether anything changed.
    prune(now) {
      let changed = false;
      links.forEach((link, id) => {
        if (link.expiresAt <= now) { links.delete(id); changed = true; }
      });
      requests.forEach((request, id) => {
        if (request.expiresAt <= now) { requests.delete(id); changed = true; }
      });
      return changed;
    },
  };
}

module.exports = { parseNetwork, describeNetwork, createLinkStore };
