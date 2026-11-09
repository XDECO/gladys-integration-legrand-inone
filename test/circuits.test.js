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
  assert.deepEqual(obs.circuit, { key: '944559-1', legrandId: 944559, unit: 1, on: true, lastSeen: 1000 });
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
  assert.equal(registry.observe(parseFrame('*2*1*0#15112945##')), null); // shutter: not supported
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
    version: 2,
    circuits: [
      { legrandId: 648966, unit: 2 },
      { legrandId: 944559, unit: 1 },
    ],
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
  assert.equal(registry.load({ version: 3, circuits: [{ legrandId: 1, unit: 1 }] }), 0);
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

// ---- toggle circuits (push buttons that always send "on") -------------------------

const PUSH = parseFrame('*1*1*0#10383457##'); // 10383457 = 648966 * 16 + 1 -> "648966-1"

test('a toggle circuit flips its assumed state at every "on" frame', () => {
  const registry = new CircuitRegistry();
  registry.setToggleKeys(['648966-1']);

  const first = registry.observe(PUSH, 1);
  assert.equal(first.circuit.on, true);
  assert.equal(first.changed, true);

  const second = registry.observe(PUSH, 2);
  assert.equal(second.circuit.on, false);
  assert.equal(second.changed, true);

  assert.equal(registry.observe(PUSH, 3).circuit.on, true);
});

test('without the toggle setting the same frames never change the state', () => {
  const registry = new CircuitRegistry();
  assert.equal(registry.observe(PUSH, 1).circuit.on, true);
  const again = registry.observe(PUSH, 2);
  assert.equal(again.circuit.on, true);
  assert.equal(again.changed, false);
});

test('an explicit "off" frame on a toggle circuit still means off', () => {
  const registry = new CircuitRegistry();
  registry.setToggleKeys(['648966-1']);
  registry.observe(PUSH, 1);
  assert.equal(registry.observe(parseFrame('*1*0*0#10383457##'), 2).circuit.on, false);
  assert.equal(registry.observe(PUSH, 3).circuit.on, true);
});

test('a toggle circuit follows a state set by a command from Gladys', () => {
  const registry = new CircuitRegistry();
  registry.setToggleKeys(['648966-1']);
  registry.setState(648966, 1, true, 1); // Gladys switched it on
  assert.equal(registry.observe(PUSH, 2).circuit.on, false); // the button then turns it off
});

test('setToggleKeys replaces the previous list, and isToggle tells', () => {
  const registry = new CircuitRegistry();
  registry.setToggleKeys(['1-1', '2-2']);
  assert.equal(registry.isToggle('1-1'), true);
  registry.setToggleKeys(['3-3']);
  assert.equal(registry.isToggle('1-1'), false);
  assert.equal(registry.isToggle('3-3'), true);
});

test('only the circuit listed as toggle flips; its neighbour does not', () => {
  const registry = new CircuitRegistry();
  registry.setToggleKeys(['648966-1']);
  registry.observe(PUSH, 1);
  const other = registry.observe(parseFrame('*1*1*0#10383458##'), 2); // unit 2, not a toggle
  assert.equal(other.circuit.on, true);
  assert.equal(registry.observe(parseFrame('*1*1*0#10383458##'), 3).circuit.on, true);
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
