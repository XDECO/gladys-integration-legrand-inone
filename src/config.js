/**
 * Integration settings. The manifest declares the form shown in Gladys; this
 * module turns the raw values into safe ones, whatever Gladys sends.
 */

export const DEFAULT_HOST = '172.17.0.1';
export const DEFAULT_PORT = 2000;

/**
 * @param {Record<string, unknown>} [raw] values from gladys.getConfig()
 * @returns {{ host: string, port: number }}
 */
export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};

  const host = typeof config.host === 'string' ? config.host.trim() : '';

  const port = Number(config.port);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;

  return {
    host: host === '' ? DEFAULT_HOST : host,
    port: validPort ? port : DEFAULT_PORT,
  };
}

/** True when two normalized configs point to the same gateway. */
export function sameGateway(a, b) {
  return Boolean(a) && Boolean(b) && a.host === b.host && a.port === b.port;
}
