/**
 * Tiny JSON file storage for the list of known circuits.
 * Lives in /data, the only writable folder of an integration container.
 *
 * Reading never throws (a missing or damaged file means "nothing saved").
 * Writing is atomic: write a temporary file, then rename it over the real one,
 * so a crash in the middle never leaves a half-written file.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export class JsonStorage {
  /**
   * @param {string} filePath
   * @param {{ fs?: typeof fsp }} [options] fs can be replaced in tests
   */
  constructor(filePath, { fs = fsp } = {}) {
    if (typeof filePath !== 'string' || filePath === '') {
      throw new TypeError('filePath is required');
    }
    this.filePath = filePath;
    this.fs = fs;
  }

  /** @returns {Promise<unknown|null>} the parsed content, or null */
  async read() {
    try {
      const text = await this.fs.readFile(this.filePath, 'utf8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** @throws if the file cannot be written */
  async write(data) {
    const tmp = `${this.filePath}.tmp`;
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await this.fs.rename(tmp, this.filePath);
  }
}
