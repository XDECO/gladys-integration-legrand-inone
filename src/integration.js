/**
 * The Gladys layer: wires the gateway (serial over TCP), the circuit registry
 * and the Gladys SDK together.
 *
 *   bus frame ──► registry ──► gladys.publishState        (state feedback)
 *   Gladys scan ──► registry ──► gladys.publishDiscoveredDevices
 *   Gladys command ──► gateway.setLight / setLightLevel / setShutter ──► registry ──► gladys.publishState
 *   Gladys scenario click ──► gateway.launchScenario (one frame) ──► linked lights
 *   a light or a scenario ──► its linked lights (settings) ──► gladys.publishState
 *
 * Everything that touches the outside world (SDK, gateway, disk, clock) is
 * injected, so the whole thing is tested without Gladys, a network or a bus.
 *
 * Rules kept on purpose:
 *   - a handler never lets an error escape into the event loop (no crash on
 *     a failed publish);
 *   - a command failure IS thrown, so Gladys shows it to the user;
 *   - states are published only when they change (Gladys limits to 300/min).
 */

import { circuitFromDevice } from './circuits.js';
import { normalizeConfig, sameGateway } from './config.js';
import {
  addressFromIdUnit,
  circuitKey,
  effectiveLevel,
  encodeLightCommand,
  encodeLightLevelCommand,
  encodeScenarioCommand,
  encodeShutterCommand,
  SHUTTER_DOWN,
  SHUTTER_STOP,
  SHUTTER_UP,
} from './protocol.js';

const LIGHT_TYPE = 'light';
const LIGHT_FEATURE = 'binary';
const BRIGHTNESS_FEATURE = 'brightness';
const SHUTTER_TYPE = 'shutter';
const SHUTTER_FEATURE = 'state';
const SCENARIO_TYPE = 'scenario';
const SCENARIO_FEATURE = 'click';
const SHUTTER_WORDS = { [SHUTTER_UP]: 'up', [SHUTTER_DOWN]: 'down', [SHUTTER_STOP]: 'stop' };
// A scenario launched from Gladys must never come back as a "click" in Gladys
// (a Gladys scene triggered by that button would loop): frames of the same key
// seen within this delay after our own send are treated as an echo and ignored.
const ECHO_WINDOW_MS = 3000;

const MESSAGES = {
  gatewayDown: (config) => ({
    en: `Cannot reach the serial gateway at ${config.host}:${config.port}. Retrying automatically.`,
    fr: `Passerelle série injoignable (${config.host}:${config.port}). Nouvelle tentative automatique.`,
  }),
};

export class LegrandIntegration {
  /**
   * @param {Object} deps
   * @param {Object} deps.gladys  GladysIntegration instance (or a fake)
   * @param {(config: {host:string, port:number}) => Object} deps.createGateway
   * @param {import('./circuits.js').CircuitRegistry} deps.registry
   * @param {{read: () => Promise<unknown>, write: (data: unknown) => Promise<void>}} deps.storage
   * @param {{light: {category: string, type: string}, brightness: {category: string, type: string},
   *          shutter: {category: string, type: string}, scenario: {category: string, type: string}}} deps.constants
   *        SDK values for a binary light, a dimmer level, a shutter state and a button that clicks
   * @param {{info: Function, warn: Function, error: Function, debug: Function}} deps.logger
   * @param {() => number} [deps.now]
   */
  constructor({ gladys, createGateway, registry, storage, constants, logger, now = Date.now }) {
    this.gladys = gladys;
    this.createGateway = createGateway;
    this.registry = registry;
    this.storage = storage;
    this.constants = constants;
    this.logger = logger;
    this.now = now;

    this.config = null;
    this.gateway = null;
    this.lastReportedConnected = null;
    this.saveChain = Promise.resolve();
    this.warnedKeys = new Set();
    this.launchedAt = new Map();
  }

  /** Register the Gladys handlers. Call before gladys.connect(). */
  attach() {
    this.gladys.onScanRequest(() => this.#onScan());
    this.gladys.onSetValue((device, feature, value) => this.#onSetValue(device, feature, value));
    this.gladys.onConfigUpdated((config) => this.#onConfigUpdated(config));
  }

  /** Load saved circuits, read the settings and open the gateway. Never throws. */
  async start() {
    try {
      const loaded = this.registry.load(await this.storage.read());
      if (loaded > 0) this.logger.info(`Loaded ${loaded} known circuit(s)`);
    } catch (error) {
      this.logger.warn('Could not load the saved circuits', error);
    }

    let raw = {};
    try {
      raw = await this.gladys.getConfig();
    } catch (error) {
      this.logger.warn('Could not read the configuration, using defaults', error);
    }
    const config = normalizeConfig(raw);
    this.#applyLinks(config);
    this.#openGateway(config);
  }

  /** Close the gateway and wait for the last save. */
  async stop() {
    this.#closeGateway();
    await this.saveChain;
  }

  // ---- Gladys -> bus ------------------------------------------------------------

  async #onSetValue(device, feature, value) {
    const circuit = circuitFromDevice(device);
    if (!circuit) {
      throw new Error(`Cannot find the circuit of device ${device && device.external_id}`);
    }
    const externalId = String(device.external_id);
    if (externalId.includes(`:${SCENARIO_TYPE}:`)) {
      return this.#launchScenario(circuit, value);
    }
    if (externalId.includes(`:${SHUTTER_TYPE}:`)) {
      return this.#moveShutter(circuit, feature, value);
    }
    if (feature && String(feature.external_id).endsWith(`:${BRIGHTNESS_FEATURE}`)) {
      return this.#setLevel(circuit, feature, value);
    }
    if (value !== 0 && value !== 1) {
      throw new Error(`Unsupported value ${value}: a light only accepts 0 or 1`);
    }
    if (!this.gateway) {
      throw new Error('The serial gateway is not configured');
    }

    const on = value === 1;
    // Throws (NOT_CONNECTED, QUEUE_FULL...) when the command cannot be written:
    // Gladys then reports the failure instead of showing a light that did not move.
    await this.gateway.setLight({ legrandId: circuit.legrandId, unit: circuit.unit, on });
    this.logger.info(`Sent ${encodeLightCommand({ legrandId: circuit.legrandId, unit: circuit.unit, on })} (${circuit.key} ${on ? 'on' : 'off'})`);

    // The bus gives no acknowledgement, so the requested state is published as
    // soon as the frame is written. A later frame from the switch corrects it.
    const { isNew } = this.registry.setState(circuit.legrandId, circuit.unit, on, this.now());
    if (isNew) this.#save();
    await this.#publish(feature.external_id, on ? 1 : 0, `light:${circuit.key}`);
    this.#propagate(circuit.key, on, true);
  }

  /**
   * Set a dimmer level from Gladys (0..100 %). The bus only knows 20..100 % by
   * steps of 10, so the level really sent is published back to Gladys.
   */
  async #setLevel(circuit, feature, value) {
    const level = Number(value);
    if (!Number.isFinite(level) || level < 0 || level > 100) {
      throw new Error(`Unsupported value ${value}: a brightness accepts 0 to 100`);
    }
    if (!this.gateway) {
      throw new Error('The serial gateway is not configured');
    }
    await this.gateway.setLightLevel({ legrandId: circuit.legrandId, unit: circuit.unit, level });
    const sent = effectiveLevel(level);
    this.logger.info(`Sent ${encodeLightLevelCommand({ legrandId: circuit.legrandId, unit: circuit.unit, level })} (${circuit.key} level ${sent} %)`);

    const { isNew } = this.registry.setLevel(circuit.legrandId, circuit.unit, sent, this.now());
    if (isNew) this.#save();
    const ids = this.gladys.externalIds(LIGHT_TYPE, circuit.key);
    await this.#publish(feature.external_id, sent, `brightness:${circuit.key}`);
    await this.#publish(ids.feature(LIGHT_FEATURE), sent > 0 ? 1 : 0, `light:${circuit.key}`);
    this.#propagate(circuit.key, sent > 0, true);
  }

  /**
   * Move a shutter from Gladys: 1 up, -1 down, 0 stop. The requested order is
   * published as the state as soon as the frame is written (the bus never says
   * where a shutter is).
   */
  async #moveShutter(circuit, feature, value) {
    if (value !== SHUTTER_UP && value !== SHUTTER_DOWN && value !== SHUTTER_STOP) {
      throw new Error(`Unsupported value ${value}: a shutter accepts 1 (up), -1 (down) or 0 (stop)`);
    }
    if (!this.gateway) {
      throw new Error('The serial gateway is not configured');
    }
    await this.gateway.setShutter({ legrandId: circuit.legrandId, unit: circuit.unit, state: value });
    this.logger.info(`Sent ${encodeShutterCommand({ legrandId: circuit.legrandId, unit: circuit.unit, state: value })} (${circuit.key} ${SHUTTER_WORDS[value]})`);

    const { isNew } = this.registry.setShutterState(circuit.legrandId, circuit.unit, value, this.now());
    if (isNew) this.#save();
    await this.#publish(feature.external_id, value, `shutter:${circuit.key}`);
  }

  /**
   * Launch a scenario key from Gladys: ONE frame on the bus (the receivers that
   * learned this scenario do the rest). The click is not published back to Gladys,
   * only the linked lights are updated on the Gladys side, like for a wall press.
   */
  async #launchScenario(circuit, value) {
    if (value !== 1) {
      throw new Error(`Unsupported value ${value}: a scenario button only accepts 1 (click)`);
    }
    if (!this.gateway) {
      throw new Error('The serial gateway is not configured');
    }
    // Remembered before the send, so even an immediate echo is recognised.
    this.launchedAt.set(circuit.key, this.now());
    try {
      await this.gateway.launchScenario({ legrandId: circuit.legrandId, unit: circuit.unit });
    } catch (error) {
      this.launchedAt.delete(circuit.key);
      throw error;
    }
    this.launchedAt.set(circuit.key, this.now());
    this.logger.info(`Sent ${encodeScenarioCommand({ legrandId: circuit.legrandId, unit: circuit.unit })} (scenario ${circuit.key} launched from Gladys)`);

    this.#propagate(circuit.key, null, false);
  }

  // ---- bus -> Gladys ------------------------------------------------------------

  #onFrame(frame) {
    // Every frame is logged, even when nothing changes: it tells whether a press reached us.
    if (frame && frame.raw) {
      const known = frame.type === 'command' && Number.isSafeInteger(frame.legrandId) && Number.isInteger(frame.unit);
      this.logger.info(`Frame received: ${frame.raw}${known ? ` (${circuitKey(frame.legrandId, frame.unit)})` : ''}`);
    }
    const observation = this.registry.observe(frame, this.now());
    if (!observation) return;

    const { kind, circuit, isNew, changed, levelChanged, becameDimmable, triggered } = observation;
    if (isNew) {
      this.logger.info(`New ${kind} seen on the bus: ${circuit.key} (address ${addressFromIdUnit(circuit.legrandId, circuit.unit)})`);
      this.#save();
    } else if (becameDimmable) {
      this.logger.info(`Light ${circuit.key} is a dimmer (frame ${frame.raw}): scan again to add its brightness`);
      this.#save();
    }

    if (kind === 'shutter') {
      if (changed) {
        this.logger.info(`Shutter ${circuit.key} (address ${addressFromIdUnit(circuit.legrandId, circuit.unit)}) ${SHUTTER_WORDS[circuit.state]} (frame ${frame.raw})`);
        const ids = this.gladys.externalIds(SHUTTER_TYPE, circuit.key);
        void this.#publish(ids.feature(SHUTTER_FEATURE), circuit.state, `shutter:${circuit.key}`);
      }
      return;
    }

    if (kind === 'light' && circuit.dimmable && (levelChanged || (changed && !circuit.on))) {
      // A level frame, or "off" on a dimmer: the brightness follows.
      const ids = this.gladys.externalIds(LIGHT_TYPE, circuit.key);
      void this.#publish(ids.feature(BRIGHTNESS_FEATURE), circuit.on ? circuit.level : 0, `brightness:${circuit.key}`);
    }
    if (kind === 'light' && changed) {
      this.logger.info(`Light ${circuit.key} (address ${addressFromIdUnit(circuit.legrandId, circuit.unit)}) is now ${circuit.on ? 'on' : 'off'} (frame ${frame.raw})`);
      const ids = this.gladys.externalIds(LIGHT_TYPE, circuit.key);
      void this.#publish(ids.feature(LIGHT_FEATURE), circuit.on ? 1 : 0, `light:${circuit.key}`);
    }
    if (kind === 'light') {
      // Every frame is a chance to resync the linked lights, even without a change here.
      this.#propagate(circuit.key, circuit.on, true);
    } else if (kind === 'scenario' && triggered) {
      const sentAt = this.launchedAt.get(circuit.key);
      if (sentAt !== undefined && this.now() - sentAt <= ECHO_WINDOW_MS) {
        this.logger.info(`Scenario ${circuit.key} frame ignored: it is the echo of a launch from Gladys (frame ${frame.raw})`);
        return;
      }
      // A button click is an event: it is published every time, not only on change.
      this.logger.info(`Scenario ${circuit.key} (address ${addressFromIdUnit(circuit.legrandId, circuit.unit)}) clicked (frame ${frame.raw})`);
      const ids = this.gladys.externalIds(SCENARIO_TYPE, circuit.key);
      void this.#publish(ids.feature(SCENARIO_FEATURE), 1, `scenario:${circuit.key}`);
      this.#propagate(circuit.key, null, false);
    }
  }

  /**
   * Copy a state onto the lights linked to a source, in Gladys only: nothing is
   * written to the bus. One level only, so links can never loop.
   * @param {string} sourceKey
   * @param {boolean|null} sourceOn  state of a light source, null for a scenario
   * @param {boolean} mirror         true: targets copy sourceOn; false: they take their own fixed state
   */
  #propagate(sourceKey, sourceOn, mirror) {
    const targets = this.links.get(sourceKey);
    if (!targets) return;
    for (const target of targets) {
      const on = mirror ? sourceOn : target.on;
      if (on === null || on === undefined) continue;
      const [legrandId, unit] = target.key.split('-').map(Number);
      const { isNew, changed } = this.registry.setState(legrandId, unit, on, this.now());
      if (isNew) this.#save();
      if (!changed) continue;
      this.logger.info(`Linked light ${target.key} is now ${on ? 'on' : 'off'} (from ${sourceKey})`);
      const ids = this.gladys.externalIds(LIGHT_TYPE, target.key);
      void this.#publish(ids.feature(LIGHT_FEATURE), on ? 1 : 0, `light:${target.key}`);
    }
  }

  async #publish(featureExternalId, state, key) {
    try {
      await this.gladys.publishState(featureExternalId, state);
      this.warnedKeys.delete(key);
    } catch (error) {
      // Expected for a circuit the user has not created in Gladys yet: say it once.
      if (this.warnedKeys.has(key)) return;
      this.warnedKeys.add(key);
      this.logger.warn(`Could not publish the state of circuit ${key} (the device may not be created in Gladys yet)`, error);
    }
  }

  // ---- discovery ----------------------------------------------------------------

  async #onScan() {
    const devices = [
      ...this.registry.list().map((circuit) => this.buildDevice(circuit)),
      ...this.registry.listShutters().map((circuit) => this.buildShutterDevice(circuit)),
      ...this.registry.listScenarios().map((circuit) => this.buildScenarioDevice(circuit)),
    ];
    if (devices.length === 0) {
      this.logger.info('Scan: no circuit known yet. Press the switches, then scan again.');
    }
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** Gladys device description of one light circuit (with a brightness when it is a dimmer). */
  buildDevice(circuit) {
    const ids = this.gladys.externalIds(LIGHT_TYPE, circuit.key);
    const features = [];
    if (circuit.dimmable) {
      features.push({
        name: 'Brightness',
        external_id: ids.feature(BRIGHTNESS_FEATURE),
        category: this.constants.brightness.category,
        type: this.constants.brightness.type,
        min: 0,
        max: 100,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      });
    }
    return {
      name: `Legrand ${circuit.key}${this.#hintSuffix(circuit)}`,
      external_id: ids.device,
      params: [
        { name: 'LEGRAND_ID', value: String(circuit.legrandId) },
        { name: 'UNIT', value: String(circuit.unit) },
        { name: 'PRODUCT_HINT', value: this.registry.productHint(circuit.legrandId).product || '' },
      ],
      features: [
        {
          name: 'On/Off',
          external_id: ids.feature(LIGHT_FEATURE),
          category: this.constants.light.category,
          type: this.constants.light.type,
          min: 0,
          max: 1,
          read_only: false,
          has_feedback: true,
          keep_history: true,
        },
        ...features,
      ],
    };
  }

  /** Gladys device description of one shutter key: up / down / stop. */
  buildShutterDevice(circuit) {
    const ids = this.gladys.externalIds(SHUTTER_TYPE, circuit.key);
    return {
      name: `Legrand volet ${circuit.key}${this.#hintSuffix(circuit)}`,
      external_id: ids.device,
      params: [
        { name: 'LEGRAND_ID', value: String(circuit.legrandId) },
        { name: 'UNIT', value: String(circuit.unit) },
        { name: 'PRODUCT_HINT', value: this.registry.productHint(circuit.legrandId).product || '' },
      ],
      features: [
        {
          name: 'Shutter',
          external_id: ids.feature(SHUTTER_FEATURE),
          category: this.constants.shutter.category,
          type: this.constants.shutter.type,
          min: SHUTTER_DOWN,
          max: SHUTTER_UP,
          read_only: false,
          has_feedback: true,
          keep_history: true,
        },
      ],
    };
  }

  /** Gladys device description of one scenario: a button that clicks (and that Gladys can click). */
  buildScenarioDevice(circuit) {
    const ids = this.gladys.externalIds(SCENARIO_TYPE, circuit.key);
    return {
      name: `Legrand scenario ${circuit.key}`,
      external_id: ids.device,
      params: [
        { name: 'LEGRAND_ID', value: String(circuit.legrandId) },
        { name: 'PRODUCT_HINT', value: this.registry.productHint(circuit.legrandId).product || '' },
        { name: 'UNIT', value: String(circuit.unit) },
      ],
      features: [
        {
          name: 'Scenario button',
          external_id: ids.feature(SCENARIO_FEATURE),
          category: this.constants.scenario.category,
          type: this.constants.scenario.type,
          min: 0,
          max: 1,
          read_only: false,
          has_feedback: false,
          keep_history: false,
        },
      ],
    };
  }

  /** " (inter)", " (variateur)", " (inter volet)" or " (inter scenario)": the kind of product the key belongs to. */
  #hintSuffix(circuit) {
    const { product } = this.registry.productHint(circuit.legrandId);
    return product ? ` (${product})` : '';
  }

  // ---- settings and gateway lifecycle ------------------------------------------

  async #onConfigUpdated(raw) {
    const next = normalizeConfig(raw);
    this.#applyLinks(next);
    if (sameGateway(this.config, next)) {
      this.config = next;
      return;
    }
    this.logger.info(`Gateway settings changed: ${next.host}:${next.port}`);
    this.#openGateway(next);
  }

  /** Keep the rules and declare the dimmers listed in the settings. */
  #applyLinks(config) {
    this.links = config.links;
    let changed = false;
    for (const key of config.dimmers) {
      if (this.registry.markDimmable(key)) {
        changed = true;
        this.logger.info(`Light ${key} declared as a dimmer in the settings: scan to add its brightness`);
      }
    }
    if (changed) this.#save();
  }

  #openGateway(config) {
    this.#closeGateway();
    this.config = config;
    this.lastReportedConnected = null;

    const gateway = this.createGateway(config);
    this.gateway = gateway;

    gateway.on('frame', (frame) => this.#onFrame(frame));
    gateway.on('warning', (error) => this.logger.warn('Gateway warning', error));
    gateway.on('state', (state) => {
      if (state === 'connected') this.#reportConnection(true);
      else if (state === 'waiting') this.#reportConnection(false);
    });
    gateway.start();
  }

  #closeGateway() {
    if (!this.gateway) return;
    const gateway = this.gateway;
    this.gateway = null;
    gateway.removeAllListeners();
    gateway.stop();
  }

  #reportConnection(connected) {
    if (this.lastReportedConnected === connected) return;
    this.lastReportedConnected = connected;
    const message = connected ? undefined : MESSAGES.gatewayDown(this.config);
    Promise.resolve(this.gladys.setConnectionStatus(connected, message)).catch((error) =>
      this.logger.warn('Could not report the connection status', error),
    );
  }

  // ---- persistence --------------------------------------------------------------

  #save() {
    this.saveChain = this.saveChain
      .then(() => this.storage.write(this.registry.toJSON()))
      .catch((error) => this.logger.warn('Could not save the circuits', error));
  }
}
