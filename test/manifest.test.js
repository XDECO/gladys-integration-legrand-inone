// Checks the rules the Gladys store applies to the manifest and the docs, and
// that the real SDK still offers everything the integration calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GladysIntegration, DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { DEFAULT_HOST, DEFAULT_PORT } from '../src/config.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));

test('manifest basics follow the store rules', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30, 'name 3..30 characters');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.en, 'English description is required');
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(text.length >= 10 && text.length <= 100, `description.${lang} is ${text.length} characters`);
  }
});

test('docker image has an explicit tag equal to the manifest version', () => {
  assert.match(manifest.docker_image, /^ghcr\.io\/[a-z0-9._/-]+:\d+\.\d+\.\d+$/);
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('package.json pins the SDK version and the license', () => {
  assert.equal(pkg.dependencies['@gladysassistant/integration-sdk'], '0.12.0');
  assert.equal(pkg.license, 'Apache-2.0');
});

test('config_schema fields are valid and match the code defaults', () => {
  const keys = manifest.config_schema.map((f) => f.key);
  assert.deepEqual(keys, ['host', 'port']);
  for (const field of manifest.config_schema) {
    assert.match(field.key, /^[a-z0-9_]+$/);
    assert.ok(field.label.en, `${field.key} needs an English label`);
  }
  const host = manifest.config_schema.find((f) => f.key === 'host');
  const port = manifest.config_schema.find((f) => f.key === 'port');
  assert.equal(host.default, DEFAULT_HOST);
  assert.equal(port.default, DEFAULT_PORT);
  assert.equal(port.type, 'number');
  assert.ok(port.default >= port.min && port.default <= port.max);
});

test('documentation exists in English and French, at least 300 characters each', () => {
  for (const file of ['docs/en.md', 'docs/fr.md']) {
    assert.ok(read(file).trim().length >= 300, `${file} is too short`);
  }
});

test('the SDK offers every call the integration makes', () => {
  for (const method of [
    'onScanRequest', 'onSetValue', 'onConfigUpdated', 'externalIds', 'publishState',
    'publishDiscoveredDevices', 'setConnectionStatus', 'getConfig', 'handleShutdown', 'connect',
  ]) {
    assert.equal(typeof GladysIntegration.prototype[method], 'function', method);
  }
});

test('the SDK constants for a binary light are the ones the code relies on', () => {
  assert.equal(DEVICE_FEATURE_CATEGORIES.LIGHT, 'light');
  assert.equal(DEVICE_FEATURE_TYPES.LIGHT.BINARY, 'binary');
});

test('externalIds builds ids that the integration can read back', async () => {
  const { circuitFromDevice } = await import('../src/circuits.js');
  const gladys = new GladysIntegration({ hostApiUrl: 'http://localhost', token: 't', selector: 'legrand' });
  const ids = gladys.externalIds('light', '944559-1');
  assert.deepEqual(circuitFromDevice({ external_id: ids.device }), { legrandId: 944559, unit: 1, key: '944559-1' });
  assert.ok(ids.feature('binary').startsWith(ids.device));
});
