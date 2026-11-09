import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  sameGateway,
  parseAddressList,
  keysFromAddresses,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from '../src/config.js';

test('defaults when nothing is configured', () => {
  assert.deepEqual(normalizeConfig(), { host: DEFAULT_HOST, port: DEFAULT_PORT, toggleAddresses: [] });
  assert.deepEqual(normalizeConfig({}), { host: '172.17.0.1', port: 2000, toggleAddresses: [] });
  assert.deepEqual(normalizeConfig(null), { host: '172.17.0.1', port: 2000, toggleAddresses: [] });
});

test('valid values are kept, the host is trimmed', () => {
  assert.deepEqual(normalizeConfig({ host: '  192.168.1.5 ', port: 4001 }), {
    host: '192.168.1.5',
    port: 4001,
    toggleAddresses: [],
  });
  assert.deepEqual(normalizeConfig({ host: 'legrand-serial', port: '2000' }), {
    host: 'legrand-serial',
    port: 2000,
    toggleAddresses: [],
  });
});

test('invalid values fall back to the defaults', () => {
  for (const port of [0, -1, 65536, 1.5, 'abc', null, undefined, NaN]) {
    assert.equal(normalizeConfig({ port }).port, 2000, `port ${String(port)}`);
  }
  for (const host of ['', '   ', 42, null, undefined]) {
    assert.equal(normalizeConfig({ host }).host, '172.17.0.1', `host ${String(host)}`);
  }
  assert.equal(normalizeConfig({ port: 1 }).port, 1);
  assert.equal(normalizeConfig({ port: 65535 }).port, 65535);
});

test('sameGateway compares host and port', () => {
  const a = { host: 'h', port: 1 };
  assert.equal(sameGateway(a, { host: 'h', port: 1 }), true);
  assert.equal(sameGateway(a, { host: 'h', port: 2 }), false);
  assert.equal(sameGateway(a, { host: 'x', port: 1 }), false);
  assert.equal(sameGateway(null, a), false);
  assert.equal(sameGateway(a, undefined), false);
});

test('toggle addresses are read from the settings text', () => {
  assert.deepEqual(normalizeConfig({ toggle_circuits: '10383457, 15112946' }).toggleAddresses, [10383457, 15112946]);
  assert.deepEqual(normalizeConfig({ toggle_circuits: 42 }).toggleAddresses, []);
});

test('parseAddressList accepts any usual separator and skips what is not an address', () => {
  assert.deepEqual(parseAddressList('1, 2;3 4\n5\t6'), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseAddressList(' 10383457 '), [10383457]);
  assert.deepEqual(parseAddressList('abc, 12x, -5, 1.5, 7'), [7]);
  assert.deepEqual(parseAddressList('5, 5, 6, 5'), [5, 6]);
  assert.deepEqual(parseAddressList('99999999999999999999'), []);
  for (const bad of ['', '   ', ',,,', null, undefined, 12, {}]) {
    assert.deepEqual(parseAddressList(bad), [], String(bad));
  }
});

test('keysFromAddresses turns addresses into circuit keys', () => {
  assert.deepEqual(keysFromAddresses([10383457, 15112946, 15112945]), ['648966-1', '944559-2', '944559-1']);
  assert.deepEqual(keysFromAddresses([]), []);
});
