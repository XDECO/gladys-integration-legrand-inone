import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, sameGateway, DEFAULT_HOST, DEFAULT_PORT } from '../src/config.js';

test('defaults when nothing is configured', () => {
  assert.deepEqual(normalizeConfig(), { host: DEFAULT_HOST, port: DEFAULT_PORT });
  assert.deepEqual(normalizeConfig({}), { host: '172.17.0.1', port: 2000 });
  assert.deepEqual(normalizeConfig(null), { host: '172.17.0.1', port: 2000 });
});

test('valid values are kept, the host is trimmed', () => {
  assert.deepEqual(normalizeConfig({ host: '  192.168.1.5 ', port: 4001 }), { host: '192.168.1.5', port: 4001 });
  assert.deepEqual(normalizeConfig({ host: 'legrand-serial', port: '2000' }), { host: 'legrand-serial', port: 2000 });
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
