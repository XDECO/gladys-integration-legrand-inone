/**
 * Registry of the circuits seen on the Legrand bus: lights, shutters and
 * scenarios.
 *
 * A circuit is one (legrandId, unit) pair. Circuits are learned from the frames
 * that the switches broadcast when the user presses them, because the bus has
 * no way to list its devices.
 *
 * The bus never says what a receiver is doing, so the state of a light is
 * deduced:
 *   - a light circuit sends "on" and "off" frames: the state is the frame.
 *   - a dimmer key also sends level frames (20..100 %): the light is then
 *     known to be dimmable and its level is the frame.
 *   Receivers driven by another circuit are linked in the settings (see config.js).
 *
 * A shutter key sends "up", "down" and "stop" frames: the last order is kept
 * as its state (the bus never says where the shutter really is).
 *
 * A scenario frame never carries a lamp state. A scenario is exposed as a
 * button: it "clicks" when the first frame ("action") arrives. The second one
 * ("stop_action", sent about 0.3 s later) is the end of the same press.
 *
 * Pure logic: no I/O, no timers, no Gladys SDK. Time is passed in.
 */

import {
  circuitKey,
  isDimmerFrame,
  lightLevelFromFrame,
  lightStateFromFrame,
  shutterStateFromFrame,
} from './protocol.js';

/**
 * @typedef {Object} Circuit
 * @property {string} key       "944559-1"
 * @property {number} legrandId
 * @property {number} unit      0..15
 * @property {boolean|null} on  last known state of a light, null if never seen
 * @property {number|null} level last known dimmer level (20..100), null if unknown
 * @property {boolean} dimmable  a dimmer frame was heard, or the settings say so
 * @property {number|null} state last shutter order (1 up, -1 down, 0 stop), null if never seen
 * @property {number} lastSeen  epoch ms of the last frame or command
 */

/**
 * @typedef {Object} Observation
 * @property {'light'|'shutter'|'scenario'} kind
 * @property {Circuit} circuit
 * @property {boolean} isNew      the circuit was not known before
 * @property {boolean} changed    light: the on/off state differs from the previous one (true for a new circuit);
 *                                shutter: the order differs from the previous one
 * @property {boolean} levelChanged light: a level was heard and differs from the previous one
 * @property {boolean} becameDimmable light: this frame is the first dimmer frame of the circuit
 * @property {boolean} triggered  scenario: this frame is the start of a press
 */

export class CircuitRegistry {
  /** @type {Map<string, Circuit>} */
  #lights = new Map();
  /** @type {Map<string, Circuit>} */
  #shutters = new Map();
  /** @type {Map<string, Circuit>} */
  #scenarios = new Map();

  /**
   * Learn from a parsed frame. Returns null when the frame is not usable.
   * @returns {Observation|null}
   */
  observe(frame, now = Date.now()) {
    if (!frame || frame.type !== 'command') return null;
    if (!Number.isSafeInteger(frame.legrandId) || !Number.isInteger(frame.unit)) return null;

    if (frame.who === 1) {
      const dimmer = isDimmerFrame(frame);
      const on = lightStateFromFrame(frame);
      if (on === null) {
        // dim up / dim down: the light is on, the level is unknown
        if (!dimmer) return null;
        return this.#record(frame.legrandId, frame.unit, { on: true, dimmer }, now);
      }
      return this.#record(frame.legrandId, frame.unit, { on, level: lightLevelFromFrame(frame), dimmer }, now);
    }
    if (frame.who === 2) {
      const state = shutterStateFromFrame(frame);
      if (state === null) return null;
      return this.#recordShutter(frame.legrandId, frame.unit, state, now);
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
    return this.#record(legrandId, unit, { on }, now);
  }

  /**
   * Record a dimmer level we sent ourselves (0 = off, else 20..100).
   * @returns {Observation}
   */
  setLevel(legrandId, unit, level, now = Date.now()) {
    if (level === 0) return this.#record(legrandId, unit, { on: false, dimmer: true }, now);
    return this.#record(legrandId, unit, { on: true, level, dimmer: true }, now);
  }

  /**
   * Record a shutter order we sent ourselves.
   * @returns {Observation}
   */
  setShutterState(legrandId, unit, state, now = Date.now()) {
    return this.#recordShutter(legrandId, unit, state, now);
  }

  /**
   * Declare a light as a dimmer (from the settings), so Gladys gets a
   * brightness feature even before a level frame is heard. Creates the circuit
   * when unknown. Returns true when something changed.
   */
  markDimmable(key) {
    const [legrandId, unit] = String(key).split('-').map(Number);
    let circuitKeyChecked;
    try {
      circuitKeyChecked = circuitKey(legrandId, unit);
    } catch {
      return false;
    }
    const existing = this.#lights.get(circuitKeyChecked);
    if (existing) {
      if (existing.dimmable) return false;
      existing.dimmable = true;
      return true;
    }
    this.#lights.set(circuitKeyChecked, emptyCircuit(circuitKeyChecked, legrandId, unit, { dimmable: true }));
    return true;
  }

  #record(legrandId, unit, { on, level = undefined, dimmer = false }, now) {
    const key = circuitKey(legrandId, unit); // validates the numbers
    const previous = this.#lights.get(key);
    const circuit = {
      key,
      legrandId,
      unit,
      on,
      // off: the level is 0; on without a level: keep the last one
      level: on === false ? 0 : (level ?? previous?.level ?? null),
      dimmable: Boolean(previous?.dimmable) || dimmer,
      state: null,
      lastSeen: now,
    };
    this.#lights.set(key, circuit);
    return {
      kind: 'light',
      circuit: { ...circuit },
      isNew: !previous,
      changed: !previous || previous.on !== on,
      levelChanged: level !== undefined && level !== null && (!previous || previous.level !== level),
      becameDimmable: dimmer && !previous?.dimmable,
      triggered: false,
    };
  }

  #recordShutter(legrandId, unit, state, now) {
    const key = circuitKey(legrandId, unit);
    const previous = this.#shutters.get(key);
    const circuit = { key, legrandId, unit, on: null, level: null, dimmable: false, state, lastSeen: now };
    this.#shutters.set(key, circuit);
    return {
      kind: 'shutter',
      circuit: { ...circuit },
      isNew: !previous,
      changed: !previous || previous.state !== state,
      levelChanged: false,
      becameDimmable: false,
      triggered: false,
    };
  }

  #observeScenario(legrandId, unit, isStart, now) {
    const key = circuitKey(legrandId, unit);
    const isNew = !this.#scenarios.has(key);
    const circuit = { key, legrandId, unit, on: null, level: null, dimmable: false, state: null, lastSeen: now };
    this.#scenarios.set(key, circuit);
    return {
      kind: 'scenario',
      circuit: { ...circuit },
      isNew,
      changed: false,
      levelChanged: false,
      becameDimmable: false,
      triggered: isStart,
    };
  }

  /** @returns {Circuit|undefined} a copy of a light */
  get(key) {
    const circuit = this.#lights.get(key);
    return circuit ? { ...circuit } : undefined;
  }

  /** @returns {Circuit|undefined} a copy of a shutter */
  getShutter(key) {
    const circuit = this.#shutters.get(key);
    return circuit ? { ...circuit } : undefined;
  }

  /** All lights, sorted by legrandId then unit, as copies. */
  list() {
    return sorted(this.#lights);
  }

  /** All shutters, sorted by legrandId then unit, as copies. */
  listShutters() {
    return sorted(this.#shutters);
  }

  /** All scenarios, sorted by legrandId then unit, as copies. */
  listScenarios() {
    return sorted(this.#scenarios);
  }

  get size() {
    return this.#lights.size + this.#shutters.size + this.#scenarios.size;
  }

  /**
   * The kind of product behind an identifier, from the keys heard so far: an
   * "inter" (only light keys), a "variateur" (a dimmer frame was heard or the
   * settings say so), an "inter volet" (shutter keys) or an "inter scenario"
   * (at least one scenario key). The bus only tells the family of each key,
   * so this is all that can be said without guessing a reference.
   * @param {number} legrandId
   * @returns {{ lights: number, shutters: number, scenarios: number, product: 'inter'|'variateur'|'inter volet'|'inter scenario'|null }}
   */
  productHint(legrandId) {
    const lightCircuits = [...this.#lights.values()].filter((c) => c.legrandId === legrandId);
    const lights = lightCircuits.length;
    const shutters = [...this.#shutters.values()].filter((c) => c.legrandId === legrandId).length;
    const scenarios = [...this.#scenarios.values()].filter((c) => c.legrandId === legrandId).length;
    let product = null;
    if (scenarios > 0) product = 'inter scenario';
    else if (lightCircuits.some((c) => c.dimmable)) product = 'variateur';
    else if (shutters > 0 && lights === 0) product = 'inter volet';
    else if (lights > 0) product = 'inter';
    return { lights, shutters, scenarios, product };
  }

  /**
   * Serializable form. The state is not saved: after a restart it is unknown
   * until the next frame, and a stale value would be worse than none. Whether
   * a light is a dimmer IS saved: it is a property of the product.
   */
  toJSON() {
    const ids = (circuits) => circuits.map(({ legrandId, unit }) => ({ legrandId, unit }));
    return {
      version: 3,
      circuits: this.list().map(({ legrandId, unit, dimmable }) => (dimmable ? { legrandId, unit, dimmable } : { legrandId, unit })),
      shutters: ids(this.listShutters()),
      scenarios: ids(this.listScenarios()),
    };
  }

  /**
   * Load a saved registry (version 1 had no scenarios, version 2 no shutters
   * nor dimmers). Invalid entries are skipped, never thrown.
   * @returns {number} how many circuits were loaded
   */
  load(data) {
    if (!data || ![1, 2, 3].includes(data.version) || !Array.isArray(data.circuits)) return 0;
    let loaded = loadInto(this.#lights, data.circuits, data.version === 3);
    if (data.version >= 2 && Array.isArray(data.scenarios)) {
      loaded += loadInto(this.#scenarios, data.scenarios);
    }
    if (data.version === 3 && Array.isArray(data.shutters)) {
      loaded += loadInto(this.#shutters, data.shutters);
    }
    return loaded;
  }
}

function emptyCircuit(key, legrandId, unit, { dimmable = false } = {}) {
  return { key, legrandId, unit, on: null, level: null, dimmable, state: null, lastSeen: 0 };
}

function sorted(map) {
  return [...map.values()]
    .sort((a, b) => a.legrandId - b.legrandId || a.unit - b.unit)
    .map((circuit) => ({ ...circuit }));
}

function loadInto(map, entries, withDimmable = false) {
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
    map.set(key, emptyCircuit(key, entry.legrandId, entry.unit, { dimmable: withDimmable && entry.dimmable === true }));
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
