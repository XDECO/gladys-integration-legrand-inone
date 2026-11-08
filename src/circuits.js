/**
 * Registry of the lighting circuits seen on the Legrand bus.
 *
 * A circuit is one (legrandId, unit) pair. Circuits are learned from the frames
 * that the switches broadcast when the user presses them, because the bus has
 * no way to list its devices. The registry also keeps the last known state of
 * each circuit, so that the Gladys layer only publishes real changes.
 *
 * Pure logic: no I/O, no timers, no Gladys SDK. Time is passed in.
 */

import { circuitKey, lightStateFromFrame } from './protocol.js';

/**
 * @typedef {Object} Circuit
 * @property {string} key       "944559-1"
 * @property {number} legrandId
 * @property {number} unit      0..15
 * @property {boolean|null} on  last known state, null if never seen
 * @property {number} lastSeen  epoch ms of the last frame or command
 */

/**
 * @typedef {Object} Observation
 * @property {Circuit} circuit
 * @property {boolean} isNew    the circuit was not known before
 * @property {boolean} changed  the state differs from the previous one (true for a new circuit)
 */

export class CircuitRegistry {
  /** @type {Map<string, Circuit>} */
  #circuits = new Map();

  /**
   * Learn from a parsed frame. Only light on/off frames that carry an address
   * are used. Returns null when the frame is not usable.
   * @returns {Observation|null}
   */
  observe(frame, now = Date.now()) {
    if (!frame || frame.type !== 'command' || frame.who !== 1) return null;
    const on = lightStateFromFrame(frame);
    if (on === null) return null;
    if (!Number.isSafeInteger(frame.legrandId) || !Number.isInteger(frame.unit)) return null;
    return this.#record(frame.legrandId, frame.unit, on, now);
  }

  /**
   * Record a state we caused ourselves (a command that was written to the bus).
   * @returns {Observation}
   */
  setState(legrandId, unit, on, now = Date.now()) {
    return this.#record(legrandId, unit, on, now);
  }

  #record(legrandId, unit, on, now) {
    const key = circuitKey(legrandId, unit); // validates the numbers
    const previous = this.#circuits.get(key);
    const circuit = { key, legrandId, unit, on, lastSeen: now };
    this.#circuits.set(key, circuit);
    return { circuit: { ...circuit }, isNew: !previous, changed: !previous || previous.on !== on };
  }

  /** @returns {Circuit|undefined} a copy */
  get(key) {
    const circuit = this.#circuits.get(key);
    return circuit ? { ...circuit } : undefined;
  }

  /** All circuits, sorted by legrandId then unit, as copies. */
  list() {
    return [...this.#circuits.values()]
      .sort((a, b) => a.legrandId - b.legrandId || a.unit - b.unit)
      .map((circuit) => ({ ...circuit }));
  }

  get size() {
    return this.#circuits.size;
  }

  /**
   * Serializable form. The state is not saved: after a restart it is unknown
   * until the next frame, and a stale value would be worse than none.
   */
  toJSON() {
    return {
      version: 1,
      circuits: this.list().map(({ legrandId, unit }) => ({ legrandId, unit })),
    };
  }

  /**
   * Load a saved registry. Invalid entries are skipped, never thrown.
   * @returns {number} how many circuits were loaded
   */
  load(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.circuits)) return 0;
    let loaded = 0;
    for (const entry of data.circuits) {
      if (!entry || !Number.isSafeInteger(entry.legrandId) || !Number.isInteger(entry.unit)) continue;
      let key;
      try {
        key = circuitKey(entry.legrandId, entry.unit);
      } catch {
        continue;
      }
      if (this.#circuits.has(key)) continue;
      this.#circuits.set(key, { key, legrandId: entry.legrandId, unit: entry.unit, on: null, lastSeen: 0 });
      loaded += 1;
    }
    return loaded;
  }
}

/**
 * Read a circuit back from a Gladys device external id or its params.
 * The device external id ends with the circuit key: "ext:<selector>:light:944559-1".
 * @param {{external_id?: string, params?: Array<{name:string,value:string}>}} device
 * @returns {{legrandId:number, unit:number, key:string}|null}
 */
export function circuitFromDevice(device) {
  if (!device) return null;

  const params = Array.isArray(device.params) ? device.params : [];
  const idParam = params.find((p) => p && p.name === 'LEGRAND_ID');
  const unitParam = params.find((p) => p && p.name === 'UNIT');
  if (idParam && unitParam) {
    const legrandId = Number(idParam.value);
    const unit = Number(unitParam.value);
    const result = toCircuit(legrandId, unit);
    if (result) return result;
  }

  if (typeof device.external_id === 'string') {
    const last = device.external_id.split(':').pop();
    const match = /^(\d+)-(\d+)$/.exec(last);
    if (match) return toCircuit(Number(match[1]), Number(match[2]));
  }
  return null;
}

function toCircuit(legrandId, unit) {
  try {
    const key = circuitKey(legrandId, unit); // throws on an invalid pair
    return { legrandId, unit, key };
  } catch {
    return null;
  }
}
