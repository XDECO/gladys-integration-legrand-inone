import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitRegistry, circuitFromDevice } from '../src/circuits.js';
import { parseFrame } from '../src/protocol.js';

// 15112945 = 944559 * 16 + 1  -> circuit "944559-1"
const ON = parseFrame('*1*1*0#15112945##');
const OFF = parseFrame('*1*0*0#15112945##');

test('a light frame creates a circuit and reports it as new and changed', () => {
  const registry = new CircuitRegistry();
  const obs = registry.observe(ON, 1000);
  assert.equal(obs.isNew, true);
  assert.equal(obs.changed, true);
  assert.deepEqual(obs.circuit, { key: '944559-1', legrandId: 944559, unit: 1, on: true, level: null, dimmable: false, state: null, lastSeen: 1000 });
  assert.equal(registry.size, 1);
});

test('the same state again is not a change; the opposite state is', () => {
  const registry = new CircuitRegistry();
  registry.observe(ON, 1);
  const again = registry.observe(ON, 2);
  assert.equal(again.isNew, false);
  assert.equal(again.changed, false);
  assert.equal(again.circuit.lastSeen, 2);

  const off = registry.observe(OFF, 3);
  assert.equal(off.isNew, false);
  assert.equal(off.changed, true);
  assert.equal(off.circuit.on, false);
});

test('frames that are not light on/off or scenario press/release are ignored', () => {
  const registry = new CircuitRegistry();
  assert.equal(registry.observe(parseFrame('*25*17*0#15112945##')), null); // scenario, unknown action
  assert.equal(registry.observe(parseFrame('*2*7*0#15112945##')), null); // shutter, unknown order
  assert.equal(registry.observe(parseFrame('*1*12*0#15112945##')), null); // light, unknown action
  assert.equal(registry.observe(parseFrame('*4*1*0#15112945##')), null); // thermostat: not supported
  assert.equal(registry.observe(parseFrame('*#*1##')), null); // ack
  assert.equal(registry.observe(parseFrame('hello')), null); // unsupported
  assert.equal(registry.observe(null), null);
  assert.equal(registry.observe(undefined), null);
  assert.equal(registry.size, 0);
});

test('setState records a state we caused and reports change correctly', () => {
  const registry = new CircuitRegistry();
  const first = registry.setState(944559, 1, true, 5);
  assert.equal(first.isNew, true);
  assert.equal(first.changed, true);
  const same = registry.setState(944559, 1, true, 6);
  assert.equal(same.changed, false);
  assert.throws(() => registry.setState(944559, 16, true), RangeError);
  assert.throws(() => registry.setState(-1, 0, true), RangeError);
});

test('get and list return copies, sorted by id then unit', () => {
  const registry = new CircuitRegistry();
  registry.setState(950680, 0, true, 1);
  registry.setState(944559, 2, false, 1);
  registry.setState(944559, 1, true, 1);
  assert.deepEqual(registry.list().map((c) => c.key), ['944559-1', '944559-2', '950680-0']);

  registry.get('944559-1').on = 'tampered';
  registry.list()[0].on = 'tampered';
  assert.equal(registry.get('944559-1').on, true);
  assert.equal(registry.get('nope'), undefined);
});

test('toJSON keeps the circuits but not their state; load restores them with an unknown state', () => {
  const registry = new CircuitRegistry();
  registry.setState(944559, 1, true, 1);
  registry.setState(648966, 2, false, 1);
  const saved = JSON.parse(JSON.stringify(registry));
  assert.deepEqual(saved, {
    version: 3,
    circuits: [
      { legrandId: 648966, unit: 2 },
      { legrandId: 944559, unit: 1 },
    ],
    shutters: [],
    scenarios: [],
  });

  const restored = new CircuitRegistry();
  assert.equal(restored.load(saved), 2);
  assert.equal(restored.get('944559-1').on, null);

  // the first frame after a restart is a "change": the state was unknown
  assert.equal(restored.observe(ON, 9).changed, true);
});

test('load skips bad data and never throws', () => {
  const registry = new CircuitRegistry();
  assert.equal(registry.load(null), 0);
  assert.equal(registry.load('text'), 0);
  assert.equal(registry.load({ version: 4, circuits: [{ legrandId: 1, unit: 1 }] }), 0);
  assert.equal(registry.size, 0);
  assert.equal(registry.load({ version: 1, circuits: 'x' }), 0);
  assert.equal(
    registry.load({
      version: 1,
      circuits: [
        null,
        { legrandId: 'abc', unit: 1 },
        { legrandId: 1, unit: 99 },
        { legrandId: -5, unit: 0 },
        { legrandId: 7, unit: 3 },
        { legrandId: 7, unit: 3 }, // duplicate
      ],
    }),
    1,
  );
  assert.deepEqual(registry.list().map((c) => c.key), ['7-3']);
});

test('load does not overwrite a circuit already known with its state', () => {
  const registry = new CircuitRegistry();
  registry.setState(944559, 1, true, 1);
  registry.load({ version: 1, circuits: [{ legrandId: 944559, unit: 1 }] });
  assert.equal(registry.get('944559-1').on, true);
});

test('circuitFromDevice reads the params first, then the external id', () => {
  const fromParams = circuitFromDevice({
    external_id: 'ext:legrand:light:1-1',
    params: [
      { name: 'LEGRAND_ID', value: '944559' },
      { name: 'UNIT', value: '1' },
    ],
  });
  assert.deepEqual(fromParams, { legrandId: 944559, unit: 1, key: '944559-1' });

  const fromId = circuitFromDevice({ external_id: 'ext:legrand:light:944559-2' });
  assert.deepEqual(fromId, { legrandId: 944559, unit: 2, key: '944559-2' });
});

test('circuitFromDevice falls back to the external id when params are unusable', () => {
  const device = {
    external_id: 'ext:legrand:light:944559-2',
    params: [
      { name: 'LEGRAND_ID', value: 'oops' },
      { name: 'UNIT', value: '2' },
    ],
  };
  assert.equal(circuitFromDevice(device).key, '944559-2');
});

test('circuitFromDevice returns null for anything it cannot read', () => {
  assert.equal(circuitFromDevice(null), null);
  assert.equal(circuitFromDevice({}), null);
  assert.equal(circuitFromDevice({ external_id: 'ext:legrand:light:abc' }), null);
  assert.equal(circuitFromDevice({ external_id: 'ext:legrand:light:5-99' }), null);
  assert.equal(circuitFromDevice({ external_id: 42 }), null);
});

// ---- scenarios ------------------------------------------------------------------------

const ACTION = parseFrame('*25*11*0#10383458##'); // 648966 unit 2
const STOP = parseFrame('*25*16*0#10383458##');

test('the "action" frame of a scenario is a trigger, the "stop_action" is not', () => {
  const registry = new CircuitRegistry();
  const start = registry.observe(ACTION, 1);
  assert.equal(start.kind, 'scenario');
  assert.equal(start.triggered, true);
  assert.equal(start.isNew, true);
  assert.equal(start.circuit.key, '648966-2');

  const end = registry.observe(STOP, 2);
  assert.equal(end.kind, 'scenario');
  assert.equal(end.triggered, false);
  assert.equal(end.isNew, false);
});

test('scenarios and lights live apart, even with the same key', () => {
  const registry = new CircuitRegistry();
  registry.observe(parseFrame('*1*1*0#10383458##'), 1); // light "648966-2"
  registry.observe(ACTION, 2); // scenario "648966-2"
  assert.equal(registry.list().length, 1);
  assert.equal(registry.listScenarios().length, 1);
  assert.equal(registry.get('648966-2').on, true);
  assert.equal(registry.size, 2);
});

test('a scenario starting alone (stop_action missed) is still learned; a stop alone is not a trigger', () => {
  const registry = new CircuitRegistry();
  const onlyStop = registry.observe(STOP, 1);
  assert.equal(onlyStop.isNew, true);
  assert.equal(onlyStop.triggered, false);
});

test('scenarios are saved and loaded, version 1 files still load', () => {
  const registry = new CircuitRegistry();
  registry.observe(ACTION, 1);
  registry.setState(944559, 1, true, 1);
  const saved = JSON.parse(JSON.stringify(registry));
  assert.deepEqual(saved.scenarios, [{ legrandId: 648966, unit: 2 }]);

  const restored = new CircuitRegistry();
  assert.equal(restored.load(saved), 2);
  assert.equal(restored.listScenarios()[0].key, '648966-2');
  assert.equal(restored.observe(ACTION, 9).isNew, false);

  const old = new CircuitRegistry();
  assert.equal(old.load({ version: 1, circuits: [{ legrandId: 7, unit: 3 }] }), 1);
  assert.equal(old.listScenarios().length, 0);
});

test('scenario entries of a saved file are validated too', () => {
  const registry = new CircuitRegistry();
  assert.equal(
    registry.load({
      version: 2,
      circuits: [],
      scenarios: [null, { legrandId: 'x', unit: 1 }, { legrandId: 5, unit: 99 }, { legrandId: 5, unit: 2 }],
    }),
    1,
  );
  assert.equal(registry.listScenarios()[0].key, '5-2');
  assert.equal(registry.load({ version: 2, circuits: [], scenarios: 'nope' }), 0);
});

// ---- product hints ------------------------------------------------------------------

test('productHint: light keys only make an "inter", any scenario key an "inter scenario"', () => {
  const registry = new CircuitRegistry();
  assert.deepEqual(registry.productHint(1), { lights: 0, shutters: 0, scenarios: 0, product: null });
  registry.observe(parseFrame('*1*1*0#15112945##'), 1); // 944559-1
  registry.observe(parseFrame('*1*1*0#15112946##'), 2); // 944559-2
  registry.observe(parseFrame('*1*1*0#10383457##'), 3); // 648966-1
  registry.observe(parseFrame('*25*11*0#10383458##'), 4); // 648966-2
  assert.deepEqual(registry.productHint(944559), { lights: 2, shutters: 0, scenarios: 0, product: 'inter' });
  assert.deepEqual(registry.productHint(648966), { lights: 1, shutters: 0, scenarios: 1, product: 'inter scenario' });
});

test('productHint: a dimmer frame makes a "variateur", shutter keys an "inter volet"', () => {
  const registry = new CircuitRegistry();
  registry.observe(parseFrame('*1*5*0#15112945##'), 1); // 944559-1 at 50 %
  assert.equal(registry.productHint(944559).product, 'variateur');
  registry.observe(parseFrame('*2*1*0#10383457##'), 2); // 648966-1 up
  assert.deepEqual(registry.productHint(648966), { lights: 0, shutters: 1, scenarios: 0, product: 'inter volet' });
});

// ---- dimmers -------------------------------------------------------------------

test('a level frame turns the light on, sets its level and marks it dimmable (once)', () => {
  const registry = new CircuitRegistry();
  const first = registry.observe(parseFrame('*1*7*0#15112945##'), 1); // 70 %
  assert.equal(first.isNew, true);
  assert.equal(first.becameDimmable, true);
  assert.equal(first.levelChanged, true);
  assert.deepEqual([first.circuit.on, first.circuit.level, first.circuit.dimmable], [true, 70, true]);

  const same = registry.observe(parseFrame('*1*7*0#15112945##'), 2);
  assert.equal(same.becameDimmable, false);
  assert.equal(same.levelChanged, false);
  assert.equal(same.changed, false);

  const off = registry.observe(OFF, 3);
  assert.equal(off.changed, true);
  assert.deepEqual([off.circuit.on, off.circuit.level, off.circuit.dimmable], [false, 0, true]);

  // "on" without a level keeps the last level unknown (0 after an off)
  const on = registry.observe(ON, 4);
  assert.equal(on.levelChanged, false);
  assert.equal(on.circuit.dimmable, true);
});

test('dim up / dim down frames mean "on" with an unknown level and mark the dimmer', () => {
  const registry = new CircuitRegistry();
  const up = registry.observe(parseFrame('*1*30*0#15112945##'), 1);
  assert.deepEqual([up.circuit.on, up.circuit.level, up.circuit.dimmable, up.becameDimmable], [true, null, true, true]);
  const down = registry.observe(parseFrame('*1*31*0#15112945##'), 2);
  assert.equal(down.becameDimmable, false);
  assert.equal(down.changed, false);
});

test('setLevel records a level we sent: 0 is off, anything else is on', () => {
  const registry = new CircuitRegistry();
  const obs = registry.setLevel(944559, 1, 40, 1);
  assert.deepEqual([obs.circuit.on, obs.circuit.level, obs.circuit.dimmable, obs.levelChanged], [true, 40, true, true]);
  const off = registry.setLevel(944559, 1, 0, 2);
  assert.deepEqual([off.circuit.on, off.circuit.level, off.changed], [false, 0, true]);
});

test('markDimmable declares a dimmer from the settings, creating the circuit when needed', () => {
  const registry = new CircuitRegistry();
  assert.equal(registry.markDimmable('944559-1'), true);
  assert.equal(registry.markDimmable('944559-1'), false); // already
  assert.equal(registry.markDimmable('bad'), false);
  assert.equal(registry.markDimmable('1-99'), false);
  assert.equal(registry.get('944559-1').dimmable, true);
  assert.equal(registry.get('944559-1').on, null);
  registry.setState(648966, 1, true, 1);
  assert.equal(registry.markDimmable('648966-1'), true);
  assert.equal(registry.get('648966-1').on, true, 'the known state is kept');
});

test('dimmable survives a save and a load; the level does not', () => {
  const registry = new CircuitRegistry();
  registry.observe(parseFrame('*1*7*0#15112945##'), 1); // dimmer 944559-1
  registry.setState(648966, 1, true, 1);
  const saved = JSON.parse(JSON.stringify(registry));
  assert.deepEqual(saved.circuits, [
    { legrandId: 648966, unit: 1 },
    { legrandId: 944559, unit: 1, dimmable: true },
  ]);
  const restored = new CircuitRegistry();
  assert.equal(restored.load(saved), 2);
  assert.equal(restored.get('944559-1').dimmable, true);
  assert.equal(restored.get('944559-1').level, null);
  assert.equal(restored.get('648966-1').dimmable, false);
});

// ---- shutters ------------------------------------------------------------------

test('shutter frames create a shutter whose state is the last order', () => {
  const registry = new CircuitRegistry();
  const up = registry.observe(parseFrame('*2*1*0#15112945##'), 1);
  assert.equal(up.kind, 'shutter');
  assert.equal(up.isNew, true);
  assert.equal(up.changed, true);
  assert.equal(up.circuit.state, 1);
  assert.equal(registry.observe(parseFrame('*2*1*0#15112945##'), 2).changed, false);
  const stop = registry.observe(parseFrame('*2*0*0#15112945##'), 3);
  assert.deepEqual([stop.changed, stop.circuit.state], [true, 0]);
  const down = registry.observe(parseFrame('*2*2*0#15112945##'), 4);
  assert.deepEqual([down.changed, down.circuit.state], [true, -1]);
  assert.deepEqual(registry.list(), [], 'a shutter is not a light');
  assert.equal(registry.listShutters().length, 1);
  assert.equal(registry.getShutter('944559-1').state, -1);
  assert.equal(registry.size, 1);
});

test('setShutterState records an order we sent; shutters are saved and loaded without state', () => {
  const registry = new CircuitRegistry();
  const obs = registry.setShutterState(944559, 1, -1, 1);
  assert.deepEqual([obs.kind, obs.isNew, obs.changed, obs.circuit.state], ['shutter', true, true, -1]);
  const saved = JSON.parse(JSON.stringify(registry));
  assert.deepEqual(saved.shutters, [{ legrandId: 944559, unit: 1 }]);
  const restored = new CircuitRegistry();
  assert.equal(restored.load(saved), 1);
  assert.equal(restored.getShutter('944559-1').state, null);
  assert.equal(restored.list().length, 0);
});

test('a version 2 file (no shutters, no dimmers) still loads', () => {
  const registry = new CircuitRegistry();
  assert.equal(registry.load({ version: 2, circuits: [{ legrandId: 1, unit: 1, dimmable: true }], scenarios: [{ legrandId: 2, unit: 2 }] }), 2);
  assert.equal(registry.get('1-1').dimmable, false, 'version 2 never had dimmers');
  assert.equal(registry.listShutters().length, 0);
});

test('productHint counts the keys of one identifier only', () => {
  const registry = new CircuitRegistry();
  registry.observe(parseFrame('*25*11*0#10383458##'), 1); // 648966-2
  assert.equal(registry.productHint(944559).product, null);
  assert.equal(registry.productHint(648966).product, 'inter scenario');
});
