/**
 * Registry of the circuits seen on the Legrand bus: lights and scenarios.
 *
 * A circuit is one (legrandId, unit) pair. Circuits are learned from the frames
 * that the switches broadcast when the user presses them, because the bus has
 * no way to list its devices.
 *
 * The bus never says what a receiver is doing, so the state of a light is
 * deduced:
 *   - a normal circuit sends "on" and "off" frames: the state is the frame;
 *   - a toggle circuit (a push button) always sends "on": each frame flips the
 *     assumed state. The user lists those circuits in the settings.
 *
 * A scenario frame never carries a lamp state. A scenario is exposed as a
 * button: it "clicks" when the first frame ("action") arrives. The second one
 * ("stop_action", sent about 0.3 s later) is the end of the same press.
 *
 * Pure logic: no I/O, no timers, no Gladys SDK. Time is passed in.
 */

import { circuitKey, lightStateFromFrame } from './protocol.js';

/**
 * @typedef {Object} Circuit
 * @property {string} key       "944559-1"
 * @property {number} legrandId
 * @property {number} unit      0..15
 * @property {boolean|null} on  last known state of a light, null if never seen
 * @property {number} lastSeen  epoch ms of the last frame or command
 */

/**
 * @typedef {Object} Observation
 * @property {'light'|'scenario'} kind
 * @property {Circuit} circuit
 * @property {boolean} isNew      the circuit was not known before
 * @property {boolean} changed    light: the state differs from the previous one (true for a new circuit)
 * @property {boolean} triggered  scenario: this frame is the start of a press
 */

export class CircuitRegistry {
  /** @type {Map<string, Circuit>} */
  #lights = new Map();
  /** @type {Map<string, Circuit>} */
  #scenarios = new Map();
  /** @type {Set<string>} */
  #toggleKeys = new Set();

  /** Circuits whose "on" frame flips the state. Replaces the previous list. */
  setToggleKeys(keys) {
    this.#toggleKeys = new Set(keys);
  }

  isToggle(key) {
    return this.#toggleKeys.has(key);
  }

  /**
   * Learn from a parsed frame. Returns null when the frame is not usable.
   * @returns {Observation|null}
   */
  observe(frame, now = Date.now()) {
    if (!frame || frame.type !== 'command') return null;
    if (!Number.isSafeInteger(frame.legrandId) || !Number.isInteger(frame.unit)) return null;

    if (frame.who === 1) {
      const on = lightStateFromFrame(frame);
      if (on === null) return null;
      return this.#observeLight(frame.legrandId, frame.unit, on, now);
    }
    if (frame.who === 25 && (frame.whatName === 'action' || frame.whatName === 'stop_action')) {
      return this.#observeScenario(frame.legrandId, frame.unit, frame.whatName === 'action', now);
    }
    return null;
  }

  /**
   * Record a light state we caused ourselves (a command written to the bus).
   * @returns {Observation}
   */
  setState(legrandId, unit, on, now = Date.now()) {
    return this.#record(legrandId, unit, on, now);
  }

  #observeLight(legrandId, unit, on, now) {
    const key = circuitKey(legrandId, unit);
    let state = on;
    if (on && this.#toggleKeys.has(key)) {
      // A push button: "on" only means "pressed", the receiver changes side.
      const previous = this.#lights.get(key);
      state = !(previous && previous.on === true);
    }
    return this.#record(legrandId, unit, state, now);
  }

  #record(legrandId, unit, on, now) {
    const key = circuitKey(legrandId, unit); // validates the numbers
    const previous = this.#lights.get(key);
    const circuit = { key, legrandId, unit, on, lastSeen: now };
    this.#lights.set(key, circuit);
    return {
      kind: 'light',
      circuit: { ...circuit },
      isNew: !previous,
      changed: !previous || previous.on !== on,
      triggered: false,
    };
  }

  #observeScenario(legrandId, unit, isStart, now) {
    const key = circuitKey(legrandId, unit);
    const isNew = !this.#scenarios.has(key);
    const circuit = { key, legrandId, unit, on: null, lastSeen: now };
    this.#scenarios.set(key, circuit);
    return { kind: 'scenario', circuit: { ...circuit }, isNew, changed: false, triggered: isStart };
  }

  /** @returns {Circuit|undefined} a copy of a light */
  get(key) {
    const circuit = this.#lights.get(key);
    return circuit ? { ...circuit } : undefined;
  }

  /** All lights, sorted by legrandId then unit, as copies. */
  list() {
    return sorted(this.#lights);
  }

  /** All scenarios, sorted by legrandId then unit, as copies. */
  listScenarios() {
    return sorted(this.#scenarios);
  }

  get size() {
    return this.#lights.size + this.#scenarios.size;
  }

  /**
   * Serializable form. The state is not saved: after a restart it is unknown
   * until the next frame, and a stale value would be worse than none.
   */
  toJSON() {
    const ids = (circuits) => circuits.map(({ legrandId, unit }) => ({ legrandId, unit }));
    return {
      version: 2,
      circuits: ids(this.list()),
      scenarios: ids(this.listScenarios()),
    };
  }

  /**
   * Load a saved registry (version 1 had no scenarios). Invalid entries are
   * skipped, never thrown.
   * @returns {number} how many circuits were loaded
   */
  load(data) {
    if (!data || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.circuits)) return 0;
    let loaded = loadInto(this.#lights, data.circuits);
    if (data.version === 2 && Array.isArray(data.scenarios)) {
      loaded += loadInto(this.#scenarios, data.scenarios);
    }
    return loaded;
  }
}

function sorted(map) {
  return [...map.values()]
    .sort((a, b) => a.legrandId - b.legrandId || a.unit - b.unit)
    .map((circuit) => ({ ...circuit }));
}

function loadInto(map, entries) {
  let loaded = 0;
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.legrandId) || !Number.isInteger(entry.unit)) continue;
    let key;
    try {
      key = circuitKey(entry.legrandId, entry.unit);
    } catch {
      continue;
    }
    if (map.has(key)) continue;
    map.set(key, { key, legrandId: entry.legrandId, unit: entry.unit, on: null, lastSeen: 0 });
    loaded += 1;
  }
  return loaded;
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
    const result = toCircuit(Number(idParam.value), Number(unitParam.value));
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
