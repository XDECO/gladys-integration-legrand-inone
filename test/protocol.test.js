import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addressFromIdUnit,
  idUnitFromAddress,
  parseFrame,
  lightStateFromFrame,
  encodeLightCommand,
  circuitKey,
  FrameDecoder,
} from '../src/protocol.js';

// Real capture from the user's installation (Legrand 882 13, 2026-11-08).
const CAPTURE =
  '*1*1*0#15112945##*1*1*0#15112946##*1*0*0#15112946##*1*0*0#15112945##' +
  '*1*1*0#15112897##*1*0*0#15112897##*1*1*0#15112898##*1*0*0#15112898##' +
  '*25*11*0#15210881##*25*16*0#15210881##*25*11*0#15210882##*25*16*0#15210882##' +
  '*25*11*0#15210883##*25*16*0#15210883##*25*11*0#15210884##*25*16*0#15210884##' +
  '*1*1*0#10383457##*25*11*0#10383458##*25*16*0#10383458##*25*11*0#10383459##' +
  '*25*16*0#10383459##*1*0*0#10383457##*1*1*0#10383457##';
const CAPTURE_FRAME_COUNT = 23;

// [frame, whoName, whatName, legrandId, unit]
// Rows marked "iobl" were confirmed by the decoded output of iobl 0.0.5 on the
// same installation. The others follow the id*16+unit rule (checked below).
const EXPECTED = [
  ['*1*1*0#15112945##', 'light', 'on', 944559, 1], // iobl
  ['*1*0*0#15112945##', 'light', 'off', 944559, 1], // iobl
  ['*1*1*0#15112946##', 'light', 'on', 944559, 2], // iobl
  ['*1*0*0#15112946##', 'light', 'off', 944559, 2], // iobl
  ['*1*1*0#15112897##', 'light', 'on', 944556, 1],
  ['*1*0*0#15112898##', 'light', 'off', 944556, 2],
  ['*25*11*0#15210881##', 'scenario', 'action', 950680, 1],
  ['*25*16*0#15210884##', 'scenario', 'stop_action', 950680, 4],
  ['*1*1*0#10383457##', 'light', 'on', 648966, 1], // iobl
  ['*1*0*0#10383457##', 'light', 'off', 648966, 1], // iobl
  ['*25*11*0#10383458##', 'scenario', 'action', 648966, 2], // iobl
  ['*25*16*0#10383458##', 'scenario', 'stop_action', 648966, 2], // iobl
  ['*25*11*0#10383459##', 'scenario', 'action', 648966, 3],
];

test('address = legrandId * 16 + unit, as seen on the bus', () => {
  assert.equal(addressFromIdUnit(944559, 1), 15112945);
  assert.equal(addressFromIdUnit(944559, 2), 15112946);
  assert.equal(addressFromIdUnit(648966, 1), 10383457);
  // Independent cross-check through hexadecimal: id in hex followed by the unit digit.
  assert.equal(addressFromIdUnit(944559, 1), parseInt('E69AF' + '1', 16));
  assert.equal(addressFromIdUnit(950680, 4), parseInt('E8198' + '4', 16));
});

test('address round trip', () => {
  for (const [legrandId, unit] of [[0, 0], [1, 15], [944559, 2], [999999, 7]]) {
    const address = addressFromIdUnit(legrandId, unit);
    assert.deepEqual(idUnitFromAddress(address), { legrandId, unit });
  }
});

test('invalid ids and units are rejected', () => {
  assert.throws(() => addressFromIdUnit(-1, 1), RangeError);
  assert.throws(() => addressFromIdUnit(1.5, 1), RangeError);
  assert.throws(() => addressFromIdUnit(944559, 16), RangeError);
  assert.throws(() => addressFromIdUnit(944559, -1), RangeError);
  assert.throws(() => addressFromIdUnit(944559, 1.5), RangeError);
  assert.throws(() => addressFromIdUnit(Number.MAX_SAFE_INTEGER, 1), RangeError);
  assert.throws(() => idUnitFromAddress(-5), RangeError);
});

test('captured frames decode to the expected device and action', () => {
  for (const [raw, whoName, whatName, legrandId, unit] of EXPECTED) {
    const frame = parseFrame(raw);
    assert.equal(frame.type, 'command', raw);
    assert.equal(frame.whoName, whoName, raw);
    assert.equal(frame.whatName, whatName, raw);
    assert.equal(frame.legrandId, legrandId, raw);
    assert.equal(frame.unit, unit, raw);
    assert.equal(frame.mode, 'broadcast', raw);
    assert.equal(frame.raw, raw);
  }
});

test('every frame of the real capture is a supported command', () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(CAPTURE);
  assert.equal(frames.length, CAPTURE_FRAME_COUNT);
  for (const raw of frames) {
    const frame = parseFrame(raw);
    assert.equal(frame.type, 'command', raw);
    assert.notEqual(frame.whoName, null, raw);
    assert.notEqual(frame.whatName, null, raw);
  }
});

test('light state reports', () => {
  assert.equal(lightStateFromFrame(parseFrame('*1*1*0#15112945##')), true);
  assert.equal(lightStateFromFrame(parseFrame('*1*0*0#15112945##')), false);
  assert.equal(lightStateFromFrame(parseFrame('*25*11*0#10383458##')), null);
  assert.equal(lightStateFromFrame(parseFrame('*#*1##')), null);
  assert.equal(lightStateFromFrame(null), null);
});

test('addressing forms are recognised', () => {
  assert.equal(parseFrame('*1*1*#15112945##').mode, 'unicast_direct');
  assert.equal(parseFrame('*1*1*15112945##').mode, 'unicast');
  assert.equal(parseFrame('*1*1*0#15112945##').mode, 'broadcast');
  assert.equal(parseFrame('*1*1*#15112945##').legrandId, 944559);
});

test('acknowledgements', () => {
  assert.equal(parseFrame('*#*1##').type, 'ack');
  assert.equal(parseFrame('*#*0##').type, 'nack');
});

test('unknown codes are kept, not guessed', () => {
  const frame = parseFrame('*2*1*#9833538##');
  assert.equal(frame.type, 'command');
  assert.equal(frame.whoName, null);
  assert.equal(frame.whatName, null);
  assert.equal(frame.raw, '*2*1*#9833538##');

  const unknownWhat = parseFrame('*1*38*0#15112945##');
  assert.equal(unknownWhat.whoName, 'light');
  assert.equal(unknownWhat.whatName, null);
});

test('malformed or unsupported frames never throw', () => {
  for (const text of ['', '##', '*1*1##', 'hello', '*1*1*abc##', '*#1*2*3##', '*1*1*0#15112945', '*1*1*#', null, undefined]) {
    const frame = parseFrame(text);
    assert.ok(['unsupported', 'ack', 'nack'].includes(frame.type), String(text));
  }
});

test('light commands match the frames validated on hardware', () => {
  assert.equal(encodeLightCommand({ legrandId: 944559, unit: 1, on: true }), '*1*1*#15112945##');
  assert.equal(encodeLightCommand({ legrandId: 944559, unit: 1, on: false }), '*1*0*#15112945##');
  assert.equal(encodeLightCommand({ legrandId: 944559, unit: 2, on: true }), '*1*1*#15112946##');
});

test('encodeLightCommand validates its input', () => {
  assert.throws(() => encodeLightCommand({ legrandId: 944559, unit: 1, on: 1 }), TypeError);
  assert.throws(() => encodeLightCommand({ legrandId: 944559, unit: 99, on: true }), RangeError);
  assert.throws(() => encodeLightCommand({ legrandId: -3, unit: 1, on: true }), RangeError);
});

test('an encoded command parses back to the same circuit', () => {
  const frame = parseFrame(encodeLightCommand({ legrandId: 648966, unit: 1, on: true }));
  assert.equal(frame.legrandId, 648966);
  assert.equal(frame.unit, 1);
  assert.equal(frame.whatName, 'on');
  assert.equal(frame.mode, 'unicast_direct');
});

test('circuitKey is stable and validated', () => {
  assert.equal(circuitKey(944559, 1), '944559-1');
  assert.throws(() => circuitKey(944559, 20), RangeError);
});

test('FrameDecoder: same result whatever the chunking', () => {
  const reference = new FrameDecoder().push(CAPTURE);
  assert.equal(reference.length, CAPTURE_FRAME_COUNT);

  // one byte at a time
  const byByte = new FrameDecoder();
  const gathered = [];
  for (const char of CAPTURE) gathered.push(...byByte.push(char));
  assert.deepEqual(gathered, reference);

  // cut at every possible position
  for (let cut = 1; cut < CAPTURE.length; cut += 1) {
    const decoder = new FrameDecoder();
    const out = [...decoder.push(CAPTURE.slice(0, cut)), ...decoder.push(CAPTURE.slice(cut))];
    assert.deepEqual(out, reference, `cut at ${cut}`);
  }
});

test('FrameDecoder accepts Buffers', () => {
  const decoder = new FrameDecoder();
  const out = decoder.push(Buffer.from('*1*1*0#1511'));
  assert.deepEqual(out, []);
  assert.deepEqual(decoder.push(Buffer.from('2945##')), ['*1*1*0#15112945##']);
});

test('FrameDecoder drops leading noise and keeps the frame', () => {
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push('xx\r\n*1*0*0#15112945##'), ['*1*0*0#15112945##']);
  assert.deepEqual(decoder.push('garbage##'), []); // terminator without frame start
});

test('FrameDecoder reset forgets a partial frame', () => {
  const decoder = new FrameDecoder();
  decoder.push('*1*1*0#1511');
  decoder.reset();
  assert.deepEqual(decoder.push('*1*0*0#15112945##'), ['*1*0*0#15112945##']);
});

test('FrameDecoder bounds its memory when no terminator arrives', () => {
  const decoder = new FrameDecoder({ maxBufferLength: 64 });
  assert.deepEqual(decoder.push('*'.repeat(100)), []);
  assert.equal(decoder.buffer, '');
  assert.equal(decoder.discardedChunks, 1);
  assert.deepEqual(decoder.push('*1*1*0#15112945##'), ['*1*1*0#15112945##']);
});
