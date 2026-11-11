import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LegrandIntegration } from '../src/integration.js';
import { CircuitRegistry } from '../src/circuits.js';
import { GatewayError } from '../src/transport.js';
import { parseFrame } from '../src/protocol.js';

const CONSTANTS = {
  light: { category: 'light', type: 'binary' },
  scenario: { category: 'button', type: 'click' },
};
// 15112945 = 944559 * 16 + 1  -> circuit "944559-1"
const ON = parseFrame('*1*1*0#15112945##');
const OFF = parseFrame('*1*0*0#15112945##');
const FEATURE_ID = 'ext:sel:light:944559-1:binary';
const SCENARIO_ACTION = parseFrame('*25*11*0#10383458##'); // 648966 unit 2
const SCENARIO_STOP = parseFrame('*25*16*0#10383458##');
const SCENARIO_FEATURE_ID = 'ext:sel:scenario:648966-2:click';
const PUSH = parseFrame('*1*1*0#10383457##'); // 648966 unit 1, a push button
const PUSH_FEATURE_ID = 'ext:sel:light:648966-1:binary';

function fakeLogger() {
  const logs = { info: [], warn: [], error: [], debug: [] };
  const logger = {};
  for (const level of Object.keys(logs)) logger[level] = (...args) => logs[level].push(args);
  logger.logs = logs;
  return logger;
}

class FakeGateway extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.started = 0;
    this.stopped = 0;
    this.commands = [];
    this.setLightError = null;
  }
  start() { this.started += 1; }
  stop() { this.stopped += 1; }
  async setLight(command) {
    if (this.setLightError) throw this.setLightError;
    this.commands.push(command);
  }
}

function fakeGladys({ config = {}, configError = null } = {}) {
  const gladys = {
    handlers: {},
    published: [],
    discovered: [],
    statuses: [],
    publishError: null,
    onScanRequest(cb) { this.handlers.scan = cb; },
    onSetValue(cb) { this.handlers.setValue = cb; },
    onConfigUpdated(cb) { this.handlers.configUpdated = cb; },
    externalIds(type, platformId) {
      const device = `ext:sel:${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },
    async getConfig() {
      if (configError) throw configError;
      return config;
    },
    async publishState(id, value) {
      if (this.publishError) throw this.publishError;
      this.published.push([id, value]);
    },
    async publishDiscoveredDevices(devices) { this.discovered.push(devices); },
    async setConnectionStatus(connected, message) { this.statuses.push([connected, message]); },
  };
  return gladys;
}

function fakeStorage({ saved = null, writeError = null } = {}) {
  return {
    saved,
    writes: [],
    async read() { return this.saved; },
    async write(data) {
      if (writeError) throw writeError;
      this.writes.push(JSON.parse(JSON.stringify(data)));
    },
  };
}

async function setup(options = {}) {
  const gladys = options.gladys || fakeGladys();
  const storage = options.storage || fakeStorage();
  const logger = fakeLogger();
  const gateways = [];
  const integration = new LegrandIntegration({
    gladys,
    createGateway: (config) => {
      const gateway = new FakeGateway(config);
      gateways.push(gateway);
      return gateway;
    },
    registry: new CircuitRegistry(),
    storage,
    constants: CONSTANTS,
    logger,
    now: () => 1000,
  });
  integration.attach();
  await integration.start();
  return { integration, gladys, storage, logger, gateways, gateway: gateways[0] };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('attach registers the three Gladys handlers', async () => {
  const { gladys } = await setup();
  assert.equal(typeof gladys.handlers.scan, 'function');
  assert.equal(typeof gladys.handlers.setValue, 'function');
  assert.equal(typeof gladys.handlers.configUpdated, 'function');
});

test('start opens the gateway with the configured host and port', async () => {
  const gladys = fakeGladys({ config: { host: '192.168.1.9', port: 4001 } });
  const { gateway, gateways } = await setup({ gladys });
  assert.equal(gateways.length, 1);
  assert.deepEqual(gateway.config, { host: '192.168.1.9', port: 4001, links: new Map() });
  assert.equal(gateway.started, 1);
});

test('start falls back to the defaults when the settings cannot be read', async () => {
  const gladys = fakeGladys({ configError: new Error('boom') });
  const { gateway, logger } = await setup({ gladys });
  assert.deepEqual(gateway.config, { host: '172.17.0.1', port: 2000, links: new Map() });
  assert.equal(logger.logs.warn.length, 1);
});

test('start loads the saved circuits, so a scan lists them right away', async () => {
  const storage = fakeStorage({ saved: { version: 2, circuits: [{ legrandId: 944559, unit: 1 }], scenarios: [] } });
  const { gladys } = await setup({ storage });
  await gladys.handlers.scan();
  assert.equal(gladys.discovered[0].length, 1);
  assert.equal(gladys.discovered[0][0].external_id, 'ext:sel:light:944559-1');
});

test('start survives a storage that throws', async () => {
  const storage = { read: async () => { throw new Error('io'); }, write: async () => {} };
  const { gateway, logger } = await setup({ storage });
  assert.equal(gateway.started, 1);
  assert.equal(logger.logs.warn.length, 1);
});

test('a frame from a new circuit is published, remembered and saved', async () => {
  const { gladys, gateway, storage } = await setup();
  gateway.emit('frame', ON);
  await tick();
  assert.deepEqual(gladys.published, [[FEATURE_ID, 1]]);
  assert.deepEqual(storage.writes, [{ version: 2, circuits: [{ legrandId: 944559, unit: 1 }], scenarios: [] }]);
});

test('the log tells the bus address to type in the push button setting', async () => {
  const { gateway, logger } = await setup();
  gateway.emit('frame', ON); // 944559-1 = address 15112945
  await tick();
  const lines = logger.logs.info.map((args) => args.join(' '));
  assert.ok(lines.some((line) => line.includes('New light seen on the bus: 944559-1 (address 15112945)')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('Light 944559-1 (address 15112945) is now on')), lines.join('\n'));
});

test('only changes are published, and off is published as 0', async () => {
  const { gladys, gateway } = await setup();
  gateway.emit('frame', ON);
  gateway.emit('frame', ON);
  gateway.emit('frame', OFF);
  gateway.emit('frame', OFF);
  await tick();
  assert.deepEqual(gladys.published, [[FEATURE_ID, 1], [FEATURE_ID, 0]]);
});

test('the circuit is saved once, not at every frame', async () => {
  const { gateway, storage } = await setup();
  gateway.emit('frame', ON);
  gateway.emit('frame', OFF);
  gateway.emit('frame', ON);
  await tick();
  assert.equal(storage.writes.length, 1);
});

test('frames that are not light on/off or scenario press/release are ignored', async () => {
  const { gladys, gateway, storage } = await setup();
  gateway.emit('frame', parseFrame('*25*17*0#15112945##'));
  gateway.emit('frame', parseFrame('*#*1##'));
  gateway.emit('frame', parseFrame('garbage'));
  await tick();
  assert.deepEqual(gladys.published, []);
  assert.deepEqual(storage.writes, []);
});

test('a failing publish never throws and is reported once per circuit', async () => {
  const gladys = fakeGladys();
  gladys.publishError = new Error('404 device not found');
  const { gateway, logger } = await setup({ gladys });
  gateway.emit('frame', ON);
  gateway.emit('frame', OFF);
  gateway.emit('frame', ON);
  await tick();
  assert.equal(logger.logs.warn.length, 1);
});

test('a circuit warns again after a publish that worked', async () => {
  const gladys = fakeGladys();
  const { gateway, logger } = await setup({ gladys });
  gladys.publishError = new Error('nope');
  gateway.emit('frame', ON);
  await tick();
  gladys.publishError = null;
  gateway.emit('frame', OFF);
  await tick();
  gladys.publishError = new Error('nope again');
  gateway.emit('frame', ON);
  await tick();
  assert.equal(logger.logs.warn.length, 2);
});

test('a failing save is logged, not thrown, and later saves still run', async () => {
  const storage = fakeStorage({ writeError: new Error('read-only') });
  const { gateway, logger, integration } = await setup({ storage });
  gateway.emit('frame', ON);
  await integration.stop();
  assert.equal(logger.logs.warn.length, 1);
  assert.deepEqual(logger.logs.warn[0][0], 'Could not save the circuits');
});

test('scan with no known circuit publishes an empty list and explains what to do', async () => {
  const { gladys, logger } = await setup();
  await gladys.handlers.scan();
  assert.deepEqual(gladys.discovered, [[]]);
  assert.match(logger.logs.info.at(-1)[0], /Press the switches/);
});

test('scan describes each light as a controllable light with feedback', async () => {
  const { gladys, gateway } = await setup();
  gateway.emit('frame', ON);
  await gladys.handlers.scan();
  assert.deepEqual(gladys.discovered[0], [
    {
      name: 'Legrand 944559-1 (inter)',
      external_id: 'ext:sel:light:944559-1',
      params: [
        { name: 'LEGRAND_ID', value: '944559' },
        { name: 'UNIT', value: '1' },
        { name: 'PRODUCT_HINT', value: 'inter' },
      ],
      features: [
        {
          name: 'On/Off',
          external_id: FEATURE_ID,
          category: 'light',
          type: 'binary',
          min: 0,
          max: 1,
          read_only: false,
          has_feedback: true,
          keep_history: true,
        },
      ],
    },
  ]);
});

test('the feature id published for a bus frame matches the one declared at discovery', async () => {
  const { gladys, gateway } = await setup();
  gateway.emit('frame', ON);
  await tick();
  await gladys.handlers.scan();
  assert.equal(gladys.published[0][0], gladys.discovered[0][0].features[0].external_id);
});

// ---- commands -------------------------------------------------------------------

const DEVICE = {
  external_id: 'ext:sel:light:944559-1',
  params: [
    { name: 'LEGRAND_ID', value: '944559' },
    { name: 'UNIT', value: '1' },
  ],
};
const FEATURE = { external_id: FEATURE_ID };

test('a Gladys command writes to the bus then publishes the requested state', async () => {
  const { gladys, gateway } = await setup();
  await gladys.handlers.setValue(DEVICE, FEATURE, 1);
  assert.deepEqual(gateway.commands, [{ legrandId: 944559, unit: 1, on: true }]);
  assert.deepEqual(gladys.published, [[FEATURE_ID, 1]]);

  await gladys.handlers.setValue(DEVICE, FEATURE, 0);
  assert.deepEqual(gateway.commands[1], { legrandId: 944559, unit: 1, on: false });
  assert.deepEqual(gladys.published[1], [FEATURE_ID, 0]);
});

test('a command works with the circuit read from the external id alone', async () => {
  const { gladys, gateway } = await setup();
  await gladys.handlers.setValue({ external_id: 'ext:sel:light:648966-2' }, FEATURE, 1);
  assert.deepEqual(gateway.commands, [{ legrandId: 648966, unit: 2, on: true }]);
});

test('a command that cannot be written fails, and no state is published', async () => {
  const { gladys, gateway } = await setup();
  gateway.setLightError = new GatewayError('NOT_CONNECTED', 'down');
  await assert.rejects(gladys.handlers.setValue(DEVICE, FEATURE, 1), { code: 'NOT_CONNECTED' });
  assert.deepEqual(gladys.published, []);
});

test('a command on a circuit never seen before saves it', async () => {
  const { gladys, storage } = await setup();
  await gladys.handlers.setValue(DEVICE, FEATURE, 1);
  await tick();
  assert.deepEqual(storage.writes, [{ version: 2, circuits: [{ legrandId: 944559, unit: 1 }], scenarios: [] }]);
});

test('a command does not fail when only the state publication fails', async () => {
  const gladys = fakeGladys();
  gladys.publishError = new Error('api down');
  const { gateway } = await setup({ gladys });
  await gladys.handlers.setValue(DEVICE, FEATURE, 1);
  assert.equal(gateway.commands.length, 1);
});

test('a bus frame after a command only publishes if the state differs', async () => {
  const { gladys, gateway } = await setup();
  await gladys.handlers.setValue(DEVICE, FEATURE, 1);
  gateway.emit('frame', ON); // same as requested: nothing new
  await tick();
  assert.equal(gladys.published.length, 1);
  gateway.emit('frame', OFF); // someone pressed the wall switch
  await tick();
  assert.deepEqual(gladys.published.at(-1), [FEATURE_ID, 0]);
});

test('unsupported values and unknown devices are refused', async () => {
  const { gladys, gateway } = await setup();
  await assert.rejects(gladys.handlers.setValue(DEVICE, FEATURE, 0.5), /only accepts 0 or 1/);
  await assert.rejects(gladys.handlers.setValue(DEVICE, FEATURE, 2), /only accepts 0 or 1/);
  await assert.rejects(gladys.handlers.setValue(DEVICE, FEATURE, '1'), /only accepts 0 or 1/);
  await assert.rejects(gladys.handlers.setValue({ external_id: 'ext:sel:light:zzz' }, FEATURE, 1), /Cannot find the circuit/);
  assert.deepEqual(gateway.commands, []);
});

// ---- settings and connection ----------------------------------------------------

test('a settings change to another gateway closes the old one and opens a new one', async () => {
  const { gladys, gateway, gateways } = await setup();
  await gladys.handlers.configUpdated({ host: '10.0.0.5', port: 2001 });
  assert.equal(gateway.stopped, 1);
  assert.equal(gateways.length, 2);
  assert.deepEqual(gateways[1].config, { host: '10.0.0.5', port: 2001, links: new Map() });
  assert.equal(gateways[1].started, 1);
});

test('a settings update that does not change the gateway does nothing', async () => {
  const { gladys, gateway, gateways } = await setup();
  await gladys.handlers.configUpdated({ host: '172.17.0.1', port: 2000 });
  await gladys.handlers.configUpdated({});
  assert.equal(gateways.length, 1);
  assert.equal(gateway.stopped, 0);
});

test('events of a replaced gateway are ignored and commands go to the new one', async () => {
  const { gladys, gateway, gateways } = await setup();
  await gladys.handlers.configUpdated({ host: '10.0.0.5', port: 2001 });
  gateway.emit('frame', ON);
  await tick();
  assert.deepEqual(gladys.published, []);

  await gladys.handlers.setValue(DEVICE, FEATURE, 1);
  assert.deepEqual(gateway.commands, []);
  assert.equal(gateways[1].commands.length, 1);
});

test('the connection status follows the gateway and is only reported on change', async () => {
  const { gladys, gateway } = await setup();
  gateway.emit('state', 'connecting');
  gateway.emit('state', 'waiting');
  gateway.emit('state', 'connecting');
  gateway.emit('state', 'waiting');
  await tick();
  assert.equal(gladys.statuses.length, 1);
  assert.equal(gladys.statuses[0][0], false);
  assert.match(gladys.statuses[0][1].en, /172\.17\.0\.1:2000/);
  assert.match(gladys.statuses[0][1].fr, /172\.17\.0\.1:2000/);

  gateway.emit('state', 'connected');
  gateway.emit('state', 'connected');
  await tick();
  assert.deepEqual(gladys.statuses.map((s) => s[0]), [false, true]);
  assert.equal(gladys.statuses[1][1], undefined);
});

test('a failing status report is logged, not thrown', async () => {
  const gladys = fakeGladys();
  gladys.setConnectionStatus = async () => { throw new Error('api down'); };
  const { gateway, logger } = await setup({ gladys });
  gateway.emit('state', 'waiting');
  await tick();
  assert.equal(logger.logs.warn.length, 1);
});

test('gateway warnings are logged', async () => {
  const { gateway, logger } = await setup();
  gateway.emit('warning', new Error('socket error'));
  assert.equal(logger.logs.warn.length, 1);
});

test('stop closes the gateway and waits for the last save', async () => {
  const { gateway, integration, storage } = await setup();
  gateway.emit('frame', ON);
  await integration.stop();
  assert.equal(gateway.stopped, 1);
  assert.equal(storage.writes.length, 1);
  await assert.rejects(
    integration.gladys.handlers.setValue(DEVICE, FEATURE, 1),
    /not configured/,
  );
});

// ---- scenarios and push buttons (version 0.2) ---------------------------------------

test('a scenario press is published once as a click; its stop frame is ignored', async () => {
  const { gladys, gateway } = await setup();
  gateway.emit('frame', SCENARIO_ACTION);
  gateway.emit('frame', SCENARIO_STOP);
  await tick();
  assert.deepEqual(gladys.published, [[SCENARIO_FEATURE_ID, 1]]);
});

test('every press of a scenario is published, even the same one again', async () => {
  const { gladys, gateway } = await setup();
  for (let i = 0; i < 3; i += 1) {
    gateway.emit('frame', SCENARIO_ACTION);
    gateway.emit('frame', SCENARIO_STOP);
  }
  await tick();
  assert.equal(gladys.published.length, 3);
});

test('a new scenario is saved once', async () => {
  const { gateway, storage } = await setup();
  gateway.emit('frame', SCENARIO_ACTION);
  gateway.emit('frame', SCENARIO_STOP);
  gateway.emit('frame', SCENARIO_ACTION);
  await tick();
  assert.deepEqual(storage.writes, [{ version: 2, circuits: [], scenarios: [{ legrandId: 648966, unit: 2 }] }]);
});

test('scan lists scenarios as read-only buttons next to the lights', async () => {
  const { gladys, gateway } = await setup();
  gateway.emit('frame', ON);
  gateway.emit('frame', SCENARIO_ACTION);
  await gladys.handlers.scan();
  const devices = gladys.discovered[0];
  assert.deepEqual(devices.map((d) => d.external_id), ['ext:sel:light:944559-1', 'ext:sel:scenario:648966-2']);
  assert.deepEqual(devices[1], {
    name: 'Legrand scenario 648966-2',
    external_id: 'ext:sel:scenario:648966-2',
    params: [
      { name: 'LEGRAND_ID', value: '648966' },
      { name: 'PRODUCT_HINT', value: 'inter scenario' },
      { name: 'UNIT', value: '2' },
    ],
    features: [
      {
        name: 'Scenario button',
        external_id: SCENARIO_FEATURE_ID,
        category: 'button',
        type: 'click',
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
    ],
  });
});

test('the scenario feature id published matches the one declared at discovery', async () => {
  const { gladys, gateway } = await setup();
  gateway.emit('frame', SCENARIO_ACTION);
  await tick();
  await gladys.handlers.scan();
  assert.equal(gladys.published[0][0], gladys.discovered[0][0].features[0].external_id);
});

test('a scenario cannot be commanded from Gladys', async () => {
  const { gladys, gateway } = await setup();
  await assert.rejects(
    gladys.handlers.setValue({ external_id: 'ext:sel:scenario:648966-2' }, { external_id: SCENARIO_FEATURE_ID }, 1),
    /cannot be commanded/,
  );
  assert.deepEqual(gateway.commands, []);
});

test('every frame received and every command sent is logged', async () => {
  const { gladys, gateway, logger } = await setup();
  gateway.emit('frame', ON);
  gateway.emit('frame', ON); // nothing changes, but the press must show in the log
  await gladys.handlers.setValue({ external_id: 'ext:sel:light:944559-1' }, { external_id: FEATURE_ID }, 0);
  const lines = logger.logs.info.map((args) => args.join(' '));
  assert.equal(lines.filter((line) => line === 'Frame received: *1*1*0#15112945## (944559-1)').length, 2, lines.join('\n'));
  assert.ok(lines.includes('Sent *1*0*#15112945## (944559-1 off)'), lines.join('\n'));
  // an acknowledgement has no circuit: it is logged as it is
  gateway.emit('frame', parseFrame('*#*1##'));
  assert.ok(logger.logs.info.map((args) => args.join(' ')).includes('Frame received: *#*1##'));
});

// ---- product hints -------------------------------------------------------------------

test('a light key is an "inter" until a scenario key of the same product is heard', async () => {
  const { gladys, gateway } = await setup();
  const names = async () => {
    await gladys.handlers.scan();
    return gladys.discovered.at(-1).map((d) => d.name);
  };
  gateway.emit('frame', parseFrame('*1*1*0#10383457##')); // 648966-1
  assert.deepEqual(await names(), ['Legrand 648966-1 (inter)']);

  gateway.emit('frame', SCENARIO_ACTION); // 648966-2: a scenario key of the same product
  assert.deepEqual(await names(), ['Legrand 648966-1 (inter scenario)', 'Legrand scenario 648966-2']);
});

test('scenario buttons carry no suffix, and their PRODUCT_HINT says "inter scenario"', async () => {
  const { gladys, gateway } = await setup();
  for (const unit of [1, 2, 3, 4]) {
    gateway.emit('frame', parseFrame(`*25*11*0#${950680 * 16 + unit}##`));
  }
  await gladys.handlers.scan();
  assert.deepEqual(gladys.discovered[0].map((d) => d.name), [
    'Legrand scenario 950680-1',
    'Legrand scenario 950680-2',
    'Legrand scenario 950680-3',
    'Legrand scenario 950680-4',
  ]);
  assert.equal(gladys.discovered[0][0].params.find((p) => p.name === 'PRODUCT_HINT').value, 'inter scenario');
});

// ---- linked devices ------------------------------------------------------------------

const L2_ID = 'ext:sel:light:944559-2:binary'; // second light of 944559
const L1_ID = FEATURE_ID; // 944559-1 (see the top of this file)
const ON_648966_1 = parseFrame('*1*1*0#10383457##'); // 648966-1 on
const OFF_648966_1 = parseFrame('*1*0*0#10383457##'); // 648966-1 off

test('lights linked to a light copy its state, from a wall button', async () => {
  const gladys = fakeGladys({ config: { link_1: '648966-1 -> 944559-1, 944559-2' } });
  const { gateway, gateways } = await setup({ gladys });
  gateway.emit('frame', ON_648966_1);
  await tick();
  assert.deepEqual(gladys.published, [
    [PUSH_FEATURE_ID, 1],
    [L1_ID, 1],
    [L2_ID, 1],
  ]);
  gateway.emit('frame', OFF_648966_1);
  await tick();
  assert.deepEqual(gladys.published.slice(3), [
    [PUSH_FEATURE_ID, 0],
    [L1_ID, 0],
    [L2_ID, 0],
  ]);
  assert.equal(gateways.length, 1);
});

test('linked lights are only published when their state changes, and nothing is written to the bus', async () => {
  const gladys = fakeGladys({ config: { links: '648966-1 -> 944559-1' } });
  const { gateway } = await setup({ gladys });
  gateway.emit('frame', ON_648966_1);
  gateway.emit('frame', ON_648966_1);
  await tick();
  assert.deepEqual(gladys.published, [[PUSH_FEATURE_ID, 1], [L1_ID, 1]]);
  assert.deepEqual(gateway.commands, []);
});

test('a repeated frame resyncs a linked light that was changed on its own', async () => {
  const gladys = fakeGladys({ config: { links: '648966-1 -> 944559-1' } });
  const { gateway } = await setup({ gladys });
  gateway.emit('frame', ON_648966_1);
  gateway.emit('frame', OFF); // 944559-1 switched off by its own switch
  gateway.emit('frame', ON_648966_1); // the group button is pressed again
  await tick();
  assert.deepEqual(gladys.published, [
    [PUSH_FEATURE_ID, 1],
    [L1_ID, 1],
    [L1_ID, 0],
    [L1_ID, 1],
  ]);
});

test('a command from Gladys on the source updates its linked lights too', async () => {
  const gladys = fakeGladys({ config: { links: '648966-1 -> 944559-1, 944559-2' } });
  const { gateway } = await setup({ gladys });
  await gladys.handlers.setValue({ external_id: 'ext:sel:light:648966-1' }, { external_id: PUSH_FEATURE_ID }, 1);
  assert.deepEqual(gateway.commands, [{ legrandId: 648966, unit: 1, on: true }]); // only the source is commanded
  assert.deepEqual(gladys.published, [
    [PUSH_FEATURE_ID, 1],
    [L1_ID, 1],
    [L2_ID, 1],
  ]);
});

test('a scenario button sets the fixed states of its linked lights', async () => {
  const gladys = fakeGladys({ config: { links: '648966-2 -> 944559-1=on, 944559-2=off, 944559-3' } });
  const { gateway } = await setup({ gladys });
  gateway.emit('frame', SCENARIO_ACTION);
  gateway.emit('frame', SCENARIO_STOP);
  await tick();
  assert.deepEqual(gladys.published, [
    [SCENARIO_FEATURE_ID, 1],
    [L1_ID, 1],
    [L2_ID, 0],
  ]); // 944559-3 has no state: skipped; the stop frame does nothing
});

test('links are applied at once when the settings change, without reopening the gateway', async () => {
  const { gladys, gateway, gateways } = await setup();
  gateway.emit('frame', ON_648966_1);
  await tick();
  assert.deepEqual(gladys.published, [[PUSH_FEATURE_ID, 1]]);

  await gladys.handlers.configUpdated({ host: '172.17.0.1', port: 2000, link_2: '648966-1 -> 944559-1' });
  assert.equal(gateways.length, 1);
  assert.equal(gateway.stopped, 0);
  gateway.emit('frame', ON_648966_1);
  await tick();
  assert.deepEqual(gladys.published.slice(1), [[L1_ID, 1]]);

  await gladys.handlers.configUpdated({ host: '172.17.0.1', port: 2000, link_2: '' }); // removed
  gateway.emit('frame', OFF_648966_1);
  await tick();
  assert.equal(gladys.published.slice(2).some(([id]) => id === L1_ID), false);
});

test('a link cannot loop: only one level is followed', async () => {
  const gladys = fakeGladys({ config: { links: '648966-1 -> 944559-1; 944559-1 -> 648966-1' } });
  const { gateway } = await setup({ gladys });
  gateway.emit('frame', ON_648966_1);
  await tick();
  assert.deepEqual(gladys.published, [[PUSH_FEATURE_ID, 1], [L1_ID, 1]]);
});

test('a linked light unknown so far is remembered and saved', async () => {
  const gladys = fakeGladys({ config: { links: '648966-1 -> 944559-2' } });
  // the source is already known, so the target is the only new circuit
  const storage = fakeStorage({ saved: { version: 2, circuits: [{ legrandId: 648966, unit: 1 }], scenarios: [] } });
  const { gateway } = await setup({ gladys, storage });
  gateway.emit('frame', ON_648966_1);
  await tick();
  assert.equal(storage.writes.length, 1);
  const saved = storage.writes[0].circuits.map((c) => `${c.legrandId}-${c.unit}`).sort();
  assert.deepEqual(saved, ['648966-1', '944559-2']);
});

test('linked lights are logged with the source', async () => {
  const gladys = fakeGladys({ config: { links: '648966-1 -> 944559-1' } });
  const { gateway, logger } = await setup({ gladys });
  gateway.emit('frame', ON_648966_1);
  await tick();
  const lines = logger.logs.info.map((args) => args.join(' '));
  assert.ok(lines.some((line) => line.includes('Linked light 944559-1 is now on (from 648966-1)')), lines.join('\n'));
});

test('a failing publish for a light does not silence the warning for a scenario', async () => {
  const gladys = fakeGladys();
  gladys.publishError = new Error('404');
  const { gateway, logger } = await setup({ gladys });
  // same key "648966-2" for a light and for a scenario
  gateway.emit('frame', parseFrame('*1*1*0#10383458##'));
  gateway.emit('frame', SCENARIO_ACTION);
  await tick();
  assert.equal(logger.logs.warn.length, 2);
});
