// Unit tests: the addresses the admin page shows for the headset app (services/network_addresses.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listServerAddresses, classify } = require('../../services/network_addresses');

const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });
const v6 = (address) => ({ family: 'IPv6', address, internal: false });

test('a Windows laptop: Wi-Fi first, then the hotspot and the wired network; virtual adapters last and not usable', () => {
  const list = listServerAddresses({
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.29.16.1')],
    'Ethernet': [v4('10.1.2.3')],
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true), { family: 'IPv6', address: '::1', internal: true }],
    'Local Area Connection* 10': [v4('192.168.137.1')],
    'Wi-Fi': [v6('fe80::1'), v4('192.168.1.229')],
    'VirtualBox Host-Only Network': [v4('192.168.56.1')]
  });
  assert.deepEqual(list.map(a => [a.address, a.kind, a.usable]), [
    ['192.168.1.229', 'wifi', true],
    ['192.168.137.1', 'hotspot', true],
    ['10.1.2.3', 'ethernet', true],
    ['172.29.16.1', 'virtual', false],
    ['192.168.56.1', 'virtual', false]
  ]);
  assert.equal(list[0].name, 'Wi-Fi');
});

test('no network: a 169.254 address is listed as not usable; loopback and IPv6 are left out', () => {
  const list = listServerAddresses({ 'Wi-Fi': [v4('169.254.20.7'), v6('fe80::2')], lo: [v4('127.0.0.1', true)] });
  assert.deepEqual(list, [{ name: 'Wi-Fi', address: '169.254.20.7', kind: 'link-local', usable: false }]);
  assert.deepEqual(listServerAddresses({}), []);
});

test('Linux and older Node names and family numbers', () => {
  assert.equal(classify('wlan0', '192.168.0.10'), 'wifi');
  assert.equal(classify('enp3s0', '192.168.0.11'), 'ethernet');
  assert.equal(classify('docker0', '172.17.0.1'), 'virtual');
  assert.equal(classify('tailscale0', '100.64.0.1'), 'virtual');
  assert.equal(classify('mystery', '192.168.0.12'), 'other');
  assert.deepEqual(listServerAddresses({ eth0: [{ family: 4, address: '192.168.0.13', internal: false }] }).map(a => a.kind), ['ethernet']);
});

test('the addresses of this computer can be read', () => {
  for (const a of listServerAddresses()) {
    assert.match(a.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(typeof a.usable, 'boolean');
  }
});
