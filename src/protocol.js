/*
 * Legrand In One (PLC) frame protocol, as spoken by the Legrand 882 13 USB
 * interface. Pure functions, no I/O: everything here can be tested alone.
 *
 * Frame syntax:   *WHO*WHAT*WHERE##
 *
 * What has been verified on real hardware (Legrand 67202 double switch):
 *   - WHO 1 = light, WHAT 1 = on, WHAT 0 = off
 *   - WHO 25 = scenario, WHAT 11 = action (press), WHAT 16 = stop_action (release)
 *   - address = legrand_id * 16 + unit
 *   - received frames use the broadcast form   WHERE = "0#<address>"
 *   - a light is driven with the direct form   WHERE = "#<address>"
 *     (the plain form "<address>" and the broadcast form did NOT work)
 *
 * Anything else is kept as-is (raw) and reported as unsupported rather than
 * guessed.
 */

export const MAX_UNIT = 15;

const WHO_NAMES = new Map([
  [1, 'light'],
  [25, 'scenario'],
]);

const WHAT_NAMES = new Map([
  ['light', new Map([[1, 'on'], [0, 'off']])],
  ['scenario', new Map([[11, 'action'], [16, 'stop_action']])],
]);

/**
 * Combine a Legrand id and a unit number into the numeric address used in frames.
 * The unit is the last hexadecimal digit of the address, so it must be 0..15.
 */
export function addressFromIdUnit(legrandId, unit) {
  if (!Number.isSafeInteger(legrandId) || legrandId < 0) {
    throw new RangeError(`Invalid legrandId: ${legrandId}`);
  }
  if (!Number.isInteger(unit) || unit < 0 || unit > MAX_UNIT) {
    throw new RangeError(`Invalid unit (expected 0..${MAX_UNIT}): ${unit}`);
  }
  const address = legrandId * 16 + unit;
  if (!Number.isSafeInteger(address)) {
    throw new RangeError(`Address out of range for legrandId ${legrandId}`);
  }
  return address;
}

/** Inverse of addressFromIdUnit. */
export function idUnitFromAddress(address) {
  if (!Number.isSafeInteger(address) || address < 0) {
    throw new RangeError(`Invalid address: ${address}`);
  }
  return { legrandId: Math.floor(address / 16), unit: address % 16 };
}

const COMMAND_RE = /^\*(\d+)\*(\d+)\*([0-9#]+)##$/;
const BROADCAST_WHERE_RE = /^0#(\d+)$/;
const DIRECT_WHERE_RE = /^#(\d+)$/;
const PLAIN_WHERE_RE = /^(\d+)$/;

function parseWhere(where) {
  let match = BROADCAST_WHERE_RE.exec(where);
  if (match) return { mode: 'broadcast', address: Number(match[1]) };
  match = DIRECT_WHERE_RE.exec(where);
  if (match) return { mode: 'unicast_direct', address: Number(match[1]) };
  match = PLAIN_WHERE_RE.exec(where);
  if (match) return { mode: 'unicast', address: Number(match[1]) };
  return null;
}

/**
 * Parse one complete frame (including the trailing "##").
 *
 * Returns one of:
 *   { type: 'command', who, whoName, what, whatName, mode, address, legrandId, unit, raw }
 *   { type: 'ack', raw }  ( *#*1## )
 *   { type: 'nack', raw } ( *#*0## )
 *   { type: 'unsupported', raw }
 * whoName / whatName are null when the code is not one we have verified.
 */
export function parseFrame(text) {
  const raw = String(text).trim();

  if (raw === '*#*1##') return { type: 'ack', raw };
  if (raw === '*#*0##') return { type: 'nack', raw };

  const match = COMMAND_RE.exec(raw);
  if (!match) return { type: 'unsupported', raw };

  const where = parseWhere(match[3]);
  if (!where || !Number.isSafeInteger(where.address)) {
    return { type: 'unsupported', raw };
  }

  const who = Number(match[1]);
  const what = Number(match[2]);
  const whoName = WHO_NAMES.get(who) ?? null;
  const whatName = (whoName && WHAT_NAMES.get(whoName)?.get(what)) ?? null;
  const { legrandId, unit } = idUnitFromAddress(where.address);

  return {
    type: 'command',
    who,
    whoName,
    what,
    whatName,
    mode: where.mode,
    address: where.address,
    legrandId,
    unit,
    raw,
  };
}

/**
 * Light state carried by a parsed frame: true (on), false (off) or null when the
 * frame is not a light on/off report.
 */
export function lightStateFromFrame(frame) {
  if (frame?.type !== 'command' || frame.whoName !== 'light') return null;
  if (frame.whatName === 'on') return true;
  if (frame.whatName === 'off') return false;
  return null;
}

/**
 * Build the frame that switches a light circuit on or off.
 * Uses the direct addressing form, the only one that worked on hardware.
 */
export function encodeLightCommand({ legrandId, unit, on }) {
  if (typeof on !== 'boolean') {
    throw new TypeError('"on" must be a boolean');
  }
  const address = addressFromIdUnit(legrandId, unit);
  return `*1*${on ? 1 : 0}*#${address}##`;
}

/**
 * Stable identifier of one circuit, usable as a Gladys external id.
 * Example: 944559 unit 1 -> "944559-1"
 */
export function circuitKey(legrandId, unit) {
  addressFromIdUnit(legrandId, unit); // validates
  return `${legrandId}-${unit}`;
}

/**
 * Splits a byte/text stream into complete frames. Frames end with "##" and can
 * arrive cut in pieces or glued together.
 */
export class FrameDecoder {
  constructor({ maxBufferLength = 4096 } = {}) {
    this.maxBufferLength = maxBufferLength;
    this.buffer = '';
    this.discardedChunks = 0;
  }

  /** Forget any partial frame (call it after a reconnection). */
  reset() {
    this.buffer = '';
  }

  /** Feed a string or Buffer; returns the raw frames completed by this chunk. */
  push(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1');

    const frames = [];
    let end = this.buffer.indexOf('##');
    while (end !== -1) {
      const candidate = this.buffer.slice(0, end + 2);
      this.buffer = this.buffer.slice(end + 2);
      const start = candidate.indexOf('*');
      if (start !== -1) frames.push(candidate.slice(start));
      end = this.buffer.indexOf('##');
    }

    if (this.buffer.length > this.maxBufferLength) {
      // No frame terminator for a long time: this is noise, not a frame.
      this.buffer = '';
      this.discardedChunks += 1;
    }
    return frames;
  }
}
