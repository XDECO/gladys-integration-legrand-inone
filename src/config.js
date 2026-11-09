/**
 * Integration settings. The manifest declares the form shown in Gladys; this
 * module turns the raw values into safe ones, whatever Gladys sends.
 */

import { circuitKey, idUnitFromAddress } from './protocol.js';

export const DEFAULT_HOST = '172.17.0.1';
export const DEFAULT_PORT = 2000;

/**
 * Read a list of bus addresses typed by the user ("10383457, 15112946").
 * Separators can be commas, semicolons, spaces or new lines. Anything that is
 * not a valid address is skipped. Duplicates are removed, order is kept.
 * @param {unknown} raw
 * @returns {number[]}
 */
export function parseAddressList(raw) {
  if (typeof raw !== 'string') return [];
  const seen = new Set();
  const result = [];
  for (const token of raw.split(/[\s,;]+/)) {
    if (!/^\d+$/.test(token)) continue;
    const address = Number(token);
    if (!Number.isSafeInteger(address) || seen.has(address)) continue;
    seen.add(address);
    result.push(address);
  }
  return result;
}

/** Circuit keys ("944559-1") of a list of addresses. */
export function keysFromAddresses(addresses) {
  return addresses.map((address) => {
    const { legrandId, unit } = idUnitFromAddress(address);
    return circuitKey(legrandId, unit);
  });
}

/**
 * @param {Record<string, unknown>} [raw] values from gladys.getConfig()
 * @returns {{ host: string, port: number, toggleAddresses: number[] }}
 */
export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};

  const host = typeof config.host === 'string' ? config.host.trim() : '';

  const port = Number(config.port);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;

  return {
    host: host === '' ? DEFAULT_HOST : host,
    port: validPort ? port : DEFAULT_PORT,
    toggleAddresses: parseAddressList(config.toggle_circuits),
  };
}

/** True when two normalized configs point to the same gateway. */
export function sameGateway(a, b) {
  return Boolean(a) && Boolean(b) && a.host === b.host && a.port === b.port;
}
