/**
 * The Gladys layer: wires the gateway (serial over TCP), the circuit registry
 * and the Gladys SDK together.
 *
 *   bus frame ──► registry ──► gladys.publishState        (state feedback)
 *   Gladys scan ──► registry ──► gladys.publishDiscoveredDevices
 *   Gladys command ──► gateway.setLight ──► registry ──► gladys.publishState
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
import { keysFromAddresses, normalizeConfig, sameGateway } from './config.js';

const LIGHT_TYPE = 'light';
const LIGHT_FEATURE = 'binary';
const SCENARIO_TYPE = 'scenario';
const SCENARIO_FEATURE = 'click';

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
   * @param {{light: {category: string, type: string}, scenario: {category: string, type: string}}} deps.constants
   *        SDK values for a binary light and for a button that clicks
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
    this.#applyToggles(config);
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
    if (String(device.external_id).includes(`:${SCENARIO_TYPE}:`)) {
      throw new Error('A scenario button cannot be commanded from Gladys');
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

    // The bus gives no acknowledgement, so the requested state is published as
    // soon as the frame is written. A later frame from the switch corrects it.
    const { isNew } = this.registry.setState(circuit.legrandId, circuit.unit, on, this.now());
    if (isNew) this.#save();
    await this.#publish(feature.external_id, on ? 1 : 0, `light:${circuit.key}`);
  }

  // ---- bus -> Gladys ------------------------------------------------------------

  #onFrame(frame) {
    const observation = this.registry.observe(frame, this.now());
    if (!observation) return;

    const { kind, circuit, isNew, changed, triggered } = observation;
    if (isNew) {
      this.logger.info(`New ${kind} seen on the bus: ${circuit.key}`);
      this.#save();
    }

    if (kind === 'light' && changed) {
      const ids = this.gladys.externalIds(LIGHT_TYPE, circuit.key);
      void this.#publish(ids.feature(LIGHT_FEATURE), circuit.on ? 1 : 0, `light:${circuit.key}`);
    } else if (kind === 'scenario' && triggered) {
      // A button click is an event: it is published every time, not only on change.
      const ids = this.gladys.externalIds(SCENARIO_TYPE, circuit.key);
      void this.#publish(ids.feature(SCENARIO_FEATURE), 1, `scenario:${circuit.key}`);
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
      ...this.registry.listScenarios().map((circuit) => this.buildScenarioDevice(circuit)),
    ];
    if (devices.length === 0) {
      this.logger.info('Scan: no circuit known yet. Press the switches, then scan again.');
    }
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** Gladys device description of one light circuit. */
  buildDevice(circuit) {
    const ids = this.gladys.externalIds(LIGHT_TYPE, circuit.key);
    return {
      name: `Legrand ${circuit.key}`,
      external_id: ids.device,
      params: [
        { name: 'LEGRAND_ID', value: String(circuit.legrandId) },
        { name: 'UNIT', value: String(circuit.unit) },
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
      ],
    };
  }

  /** Gladys device description of one scenario: a button that clicks. */
  buildScenarioDevice(circuit) {
    const ids = this.gladys.externalIds(SCENARIO_TYPE, circuit.key);
    return {
      name: `Legrand scenario ${circuit.key}`,
      external_id: ids.device,
      params: [
        { name: 'LEGRAND_ID', value: String(circuit.legrandId) },
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
          read_only: true,
          has_feedback: false,
          keep_history: false,
        },
      ],
    };
  }

  // ---- settings and gateway lifecycle ------------------------------------------

  async #onConfigUpdated(raw) {
    const next = normalizeConfig(raw);
    this.#applyToggles(next);
    if (sameGateway(this.config, next)) {
      this.config = next;
      return;
    }
    this.logger.info(`Gateway settings changed: ${next.host}:${next.port}`);
    this.#openGateway(next);
  }

  #applyToggles(config) {
    this.registry.setToggleKeys(keysFromAddresses(config.toggleAddresses));
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
