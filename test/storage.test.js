import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStorage } from '../src/storage.js';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'legrand-storage-'));
}

test('write then read gives back the data, creating missing folders', async () => {
  const dir = await tempDir();
  const storage = new JsonStorage(path.join(dir, 'deep', 'circuits.json'));
  await storage.write({ version: 1, circuits: [{ legrandId: 1, unit: 2 }] });
  assert.deepEqual(await storage.read(), { version: 1, circuits: [{ legrandId: 1, unit: 2 }] });
  await fsp.rm(dir, { recursive: true });
});

test('read returns null for a missing file and for a damaged file', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'circuits.json');
  const storage = new JsonStorage(file);
  assert.equal(await storage.read(), null);
  await fsp.writeFile(file, '{ not json', 'utf8');
  assert.equal(await storage.read(), null);
  await fsp.rm(dir, { recursive: true });
});

test('a second write replaces the first and leaves no temporary file', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'circuits.json');
  const storage = new JsonStorage(file);
  await storage.write({ n: 1 });
  await storage.write({ n: 2 });
  assert.deepEqual(await storage.read(), { n: 2 });
  assert.deepEqual(await fsp.readdir(dir), ['circuits.json']);
  await fsp.rm(dir, { recursive: true });
});

test('a failed write keeps the previous file intact', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'circuits.json');
  const storage = new JsonStorage(file);
  await storage.write({ n: 1 });

  const failing = new JsonStorage(file, {
    fs: { ...fsp, rename: async () => { throw new Error('disk full'); } },
  });
  await assert.rejects(failing.write({ n: 2 }), /disk full/);
  assert.deepEqual(await storage.read(), { n: 1 });
  await fsp.rm(dir, { recursive: true });
});

test('the constructor requires a path', () => {
  assert.throws(() => new JsonStorage(''), TypeError);
  assert.throws(() => new JsonStorage(undefined), TypeError);
});
