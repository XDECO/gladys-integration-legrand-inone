import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  sameGateway,
  parseLinks,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from '../src/config.js';

test('defaults when nothing is configured', () => {
  assert.deepEqual(normalizeConfig(), { host: DEFAULT_HOST, port: DEFAULT_PORT, links: new Map() });
  assert.deepEqual(normalizeConfig({}), { host: '172.17.0.1', port: 2000, links: new Map() });
  assert.deepEqual(normalizeConfig(null), { host: '172.17.0.1', port: 2000, links: new Map() });
});

test('valid values are kept, the host is trimmed', () => {
  assert.deepEqual(normalizeConfig({ host: '  192.168.1.5 ', port: 4001 }), {
    host: '192.168.1.5',
    port: 4001,
    links: new Map(),
  });
  assert.deepEqual(normalizeConfig({ host: 'legrand-serial', port: '2000' }), {
    host: 'legrand-serial',
    port: 2000,
    links: new Map(),
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

test('links are read from the settings text', () => {
  const links = normalizeConfig({ links: '648966-1 -> 944559-1, 944559-2' }).links;
  assert.deepEqual([...links], [['648966-1', [{ key: '944559-1', on: null }, { key: '944559-2', on: null }]]]);
  assert.equal(normalizeConfig({ links: 42 }).links.size, 0);
});

test('parseLinks reads several rules, fixed states and both arrow styles', () => {
  const links = parseLinks('648966-1 -> 944559-1; 648966-2 > 944559-1=on, 944559-2=OFF\n648966-3 -> 944559-2=1 944559-1=0');
  assert.deepEqual(links.get('648966-1'), [{ key: '944559-1', on: null }]);
  assert.deepEqual(links.get('648966-2'), [{ key: '944559-1', on: true }, { key: '944559-2', on: false }]);
  assert.deepEqual(links.get('648966-3'), [{ key: '944559-2', on: true }, { key: '944559-1', on: false }]);
});

test('parseLinks reads the fixed state whatever the case', () => {
  assert.deepEqual(parseLinks('1-1 -> 2-1=ON, 2-2=Off').get('1-1'), [{ key: '2-1', on: true }, { key: '2-2', on: false }]);
});

test('parseLinks skips what is not valid and never throws', () => {
  assert.equal(parseLinks('').size, 0);
  assert.equal(parseLinks(undefined).size, 0);
  assert.equal(parseLinks('nonsense').size, 0);
  assert.equal(parseLinks('648966-1 ->').size, 0); // no target
  assert.equal(parseLinks('648966-1 -> abc').size, 0);
  assert.equal(parseLinks('648966-16 -> 944559-1').size, 0); // unit out of range (0..15)
  assert.equal(parseLinks('648966-1 -> 944559-16').size, 0);
  assert.equal(parseLinks('648966-1 -> 648966-1').size, 0); // a light cannot follow itself
  assert.deepEqual(parseLinks('648966-1 -> abc, 944559-1, 944559-2=maybe').get('648966-1'), [{ key: '944559-1', on: null }]);
});

test('parseLinks merges rules of the same source and keeps the last state of a repeated target', () => {
  const links = parseLinks('648966-2 -> 944559-1=on; 648966-2 -> 944559-2=off, 944559-1=off');
  assert.deepEqual(links.get('648966-2'), [{ key: '944559-1', on: false }, { key: '944559-2', on: false }]);
});
