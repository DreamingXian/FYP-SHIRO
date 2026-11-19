// =============================================================================
// SHIRO Edge Server - the addresses a headset can use to reach this computer
// =============================================================================
// As an app on the headset (APK), the headset reaches the edge server at this
// computer's address on the ward Wi-Fi; 127.0.0.1 only works over the Quest Link
// cable. The admin page shows the list (ADMIN → Headset Pairing), the clinician
// types it on the hand slate (System → Server address).
// Read at each request: the computer can join another network, or switch its
// mobile hotspot on, while the server runs.
const os = require('os');

// Shown first: the networks a headset can join
const KIND_ORDER = ['wifi', 'hotspot', 'ethernet', 'other', 'virtual', 'link-local'];

const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Bluetooth|Tailscale|ZeroTier|Hamachi|VPN|TAP-|WireGuard|utun|docker\d|br-|veth/i;

/** What kind of network an adapter is on, from its name and address. */
function classify(name, address) {
  if (address.startsWith('169.254.')) return 'link-local';      // no network (no address from a router)
  if (VIRTUAL_ADAPTER.test(name)) return 'virtual';             // virtual machines, VPNs: not reachable from the headset
  if (address.startsWith('192.168.137.')) return 'hotspot';     // Windows mobile hotspot of this computer
  if (/wi-?fi|wlan|wireless/i.test(name)) return 'wifi';
  if (/ethernet|^eth\d|^en(p|s|o)?\d/i.test(name)) return 'ethernet';
  return 'other';
}

/**
 * The IPv4 addresses of this computer, the most likely one for a headset first.
 * @param {object} [nets] os.networkInterfaces() (given in tests)
 * @returns {{name: string, address: string, kind: string, usable: boolean}[]}
 */
function listServerAddresses(nets = os.networkInterfaces()) {
  const list = [];
  for (const [name, entries] of Object.entries(nets || {})) {
    for (const entry of entries || []) {
      const ipv4 = entry.family === 'IPv4' || entry.family === 4; // a number in Node 18.0 to 18.3
      if (!ipv4 || entry.internal) continue;
      const kind = classify(name, entry.address);
      list.push({ name, address: entry.address, kind, usable: kind !== 'virtual' && kind !== 'link-local' });
    }
  }
  return list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

module.exports = { listServerAddresses, classify };
