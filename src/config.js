/**
 * Integration settings. The manifest declares the form shown in Gladys; this
 * module turns the raw values into safe ones, whatever Gladys sends.
 */

import { circuitKey, MAX_UNIT } from './protocol.js';

export const DEFAULT_HOST = '172.17.0.1';
export const DEFAULT_PORT = 2000;

/** Number of "rule" fields in the settings form (link_1 ... link_N). */
export const LINK_FIELDS = 6;

/**
 * Read the "linked devices" setting. One rule per line (or separated by ";"):
 *
 *   648966-1 -> 944559-1, 944559-2        the targets copy the state of the source
 *   648966-2 -> 944559-1=on, 944559-2=off a scenario button sets fixed states
 *
 * Keys are the ones printed in the logs ("944559-1"). For a light source the
 * "=on" / "=off" part is ignored; for a scenario source a target without it
 * is skipped. Invalid rules or targets are skipped, never thrown.
 * @param {unknown} raw
 * @returns {Map<string, {key: string, on: boolean|null}[]>} source key -> targets
 */
export function parseLinks(raw) {
  const links = new Map();
  if (typeof raw !== 'string') return links;

  for (const rule of raw.split(/[;\n]+/)) {
    const match = /^\s*(\d+-\d+)\s*-?>\s*(.+?)\s*$/.exec(rule);
    if (!match) continue;
    const source = parseKey(match[1]);
    if (!source) continue;

    const targets = links.get(source) || [];
    for (const token of match[2].split(/[,\s]+/)) {
      const target = /^(\d+-\d+)(?:=(on|off|1|0))?$/i.exec(token);
      if (!target) continue;
      const key = parseKey(target[1]);
      if (!key || key === source) continue;
      const on = target[2] === undefined ? null : ['on', '1'].includes(target[2].toLowerCase());
      const existing = targets.findIndex((item) => item.key === key);
      if (existing >= 0) targets[existing] = { key, on };
      else targets.push({ key, on });
    }
    if (targets.length > 0) links.set(source, targets);
  }
  return links;
}

/**
 * The text of all the rule fields (link_1 ... link_6, one rule each), plus the
 * older single "links" field, joined as lines for parseLinks().
 */
function linkText(config) {
  const parts = [config.links];
  for (let index = 1; index <= LINK_FIELDS; index += 1) parts.push(config[`link_${index}`]);
  return parts.filter((part) => typeof part === 'string').join('\n');
}

/** "944559-1" -> the same key when the numbers are valid, else null. */
function parseKey(text) {
  const [id, unit] = text.split('-').map(Number);
  if (!Number.isSafeInteger(id) || !Number.isInteger(unit) || unit < 0 || unit > MAX_UNIT) return null;
  return circuitKey(id, unit);
}

/**
 * @param {Record<string, unknown>} [raw] values from gladys.getConfig()
 * @returns {{ host: string, port: number, links: Map<string, {key: string, on: boolean|null}[]> }}
 */
export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};

  const host = typeof config.host === 'string' ? config.host.trim() : '';

  const port = Number(config.port);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;

  return {
    host: host === '' ? DEFAULT_HOST : host,
    port: validPort ? port : DEFAULT_PORT,
    links: parseLinks(linkText(config)),
  };
}

/** True when two normalized configs point to the same gateway. */
export function sameGateway(a, b) {
  return Boolean(a) && Boolean(b) && a.host === b.host && a.port === b.port;
}
