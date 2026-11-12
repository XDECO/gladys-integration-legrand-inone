import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { LegrandGateway, GatewayError, backoffDelay } from '../src/transport.js';

// ---- helpers ---------------------------------------------------------------

/** Fake gateway: a TCP server that records its sockets and what they receive. */
async function startFakeServer(onConnection = () => {}) {
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.resume(); // always read, otherwise the end of the connection is never noticed
    onConnection(socket, sockets.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function once(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args[0]);
    });
  });
}

function collect(emitter, event) {
  const items = [];
  emitter.on(event, (item) => items.push(item));
  return items;
}

function waitUntil(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timeout in waitUntil'));
      }
    }, 5);
  });
}

function fastGateway(port, options = {}) {
  return new LegrandGateway({
    host: '127.0.0.1',
    port,
    sendIntervalMs: 0,
    ackTimeoutMs: 0, // the fake server of most tests never answers
    minReconnectDelayMs: 10,
    maxReconnectDelayMs: 40,
    ...options,
  });
}

async function freeClosedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---- tests -----------------------------------------------------------------

test('backoffDelay grows by the factor and is capped', () => {
  const options = { minDelayMs: 1000, maxDelayMs: 30000, factor: 2 };
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((attempt) => backoffDelay(attempt, options)),
    [1000, 2000, 4000, 8000, 16000, 30000],
  );
  assert.equal(backoffDelay(10_000, options), 30000);
});

test('constructor validates host and port', () => {
  assert.throws(() => new LegrandGateway({ port: 2000 }), TypeError);
  assert.throws(() => new LegrandGateway({ host: 'x', port: 0 }), RangeError);
  assert.throws(() => new LegrandGateway({ host: 'x', port: 70000 }), RangeError);
});

test('connects and emits frames, even when cut in pieces', async () => {
  const server = await startFakeServer((socket) => {
    socket.write('*1*1*0#1511');
    setTimeout(() => socket.write('2945##*1*0*0#15112945##'), 20);
  });
  const gateway = fastGateway(server.port);
  const frames = collect(gateway, 'frame');
  try {
    gateway.start();
    await waitUntil(() => frames.length === 2);
    assert.equal(frames[0].whatName, 'on');
    assert.equal(frames[0].legrandId, 944559);
    assert.equal(frames[0].unit, 1);
    assert.equal(frames[1].whatName, 'off');
    assert.equal(gateway.connected, true);
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('setLight writes the validated frame', async () => {
  let received = '';
  const server = await startFakeServer((socket) => socket.on('data', (d) => (received += d.toString())));
  const gateway = fastGateway(server.port);
  try {
    gateway.start();
    await once(gateway, 'connected');
    await gateway.setLight({ legrandId: 944559, unit: 1, on: true });
    await gateway.setLight({ legrandId: 944559, unit: 1, on: false });
    await waitUntil(() => received.length >= 32);
    assert.equal(received, '*1*1*#15112945##*1*0*#15112945##');
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('launchScenario writes the scenario frame, in order with the lights', async () => {
  let received = '';
  const server = await startFakeServer((socket) => socket.on('data', (d) => (received += d.toString())));
  const gateway = fastGateway(server.port);
  try {
    gateway.start();
    await once(gateway, 'connected');
    await gateway.launchScenario({ legrandId: 648966, unit: 3 });
    await gateway.setLight({ legrandId: 944559, unit: 1, on: false });
    await waitUntil(() => received.length >= 34);
    assert.equal(received, '*25*11*#10383459##*1*0*#15112945##');
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('writes are spaced by sendIntervalMs and keep their order', async () => {
  let received = '';
  const server = await startFakeServer((socket) => socket.on('data', (d) => (received += d.toString())));
  const interval = 80;
  const gateway = fastGateway(server.port, { sendIntervalMs: interval });
  try {
    gateway.start();
    await once(gateway, 'connected');
    const times = [];
    const frames = ['*1*1*#15112945##', '*1*0*#15112945##', '*1*1*#15112946##'];
    await Promise.all(
      frames.map((frame) =>
        gateway.send(frame).then(() => times.push(performance.now())),
      ),
    );
    assert.equal(times.length, 3);
    assert.ok(times[1] - times[0] >= interval - 15, `gap 1 was ${times[1] - times[0]}`);
    assert.ok(times[2] - times[1] >= interval - 15, `gap 2 was ${times[2] - times[1]}`);
    await waitUntil(() => received.length >= frames.join('').length);
    assert.equal(received, frames.join(''));
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('commands are rejected at once when not connected', async () => {
  const gateway = fastGateway(2000);
  await assert.rejects(
    gateway.setLight({ legrandId: 944559, unit: 1, on: true }),
    (error) => error instanceof GatewayError && error.code === 'NOT_CONNECTED',
  );
});

test('invalid frames are rejected', async () => {
  const server = await startFakeServer();
  const gateway = fastGateway(server.port);
  try {
    gateway.start();
    await once(gateway, 'connected');
    for (const bad of ['hello', '*1*1*#15112945', '', null, 42, '*1*1*#abc##']) {
      await assert.rejects(gateway.send(bad), (error) => error.code === 'INVALID_FRAME', String(bad));
    }
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('waiting commands are rejected when the connection drops', async () => {
  const server = await startFakeServer();
  const gateway = fastGateway(server.port, { sendIntervalMs: 400, minReconnectDelayMs: 1000, maxReconnectDelayMs: 1000 });
  try {
    gateway.start();
    await once(gateway, 'connected');
    const first = gateway.send('*1*1*#15112945##');
    const second = gateway.send('*1*0*#15112945##');
    const third = gateway.send('*1*1*#15112946##');
    await first; // the first one goes out immediately
    const disconnected = once(gateway, 'disconnected');
    server.sockets[0].destroy();
    await disconnected;
    const results = await Promise.allSettled([second, third]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.code, 'DISCONNECTED');
    }
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('reconnects by itself after the server drops the connection', async () => {
  const server = await startFakeServer((socket, count) => {
    if (count === 1) setTimeout(() => socket.destroy(), 20);
  });
  const gateway = fastGateway(server.port);
  const states = collect(gateway, 'state');
  try {
    gateway.start();
    await once(gateway, 'connected');
    await once(gateway, 'disconnected');
    await once(gateway, 'connected');
    assert.equal(server.sockets.length, 2);
    assert.deepEqual(states.slice(0, 5), ['connecting', 'connected', 'waiting', 'connecting', 'connected']);
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('a half frame from the old connection is not glued to the next one', async () => {
  const server = await startFakeServer((socket, count) => {
    if (count === 1) {
      socket.write('*1*1*0#1511');
      setTimeout(() => socket.destroy(), 20);
    } else {
      socket.write('*1*0*0#15112945##');
    }
  });
  const gateway = fastGateway(server.port);
  const frames = collect(gateway, 'frame');
  try {
    gateway.start();
    await waitUntil(() => frames.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].type, 'command');
    assert.equal(frames[0].raw, '*1*0*0#15112945##');
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('keeps retrying with a growing delay while the gateway is down, and stop() ends it', async () => {
  const port = await freeClosedPort();
  const gateway = fastGateway(port, { minReconnectDelayMs: 10, maxReconnectDelayMs: 40 });
  const warnings = collect(gateway, 'warning');
  const stamps = [];
  gateway.on('state', (state) => state === 'connecting' && stamps.push(performance.now()));
  gateway.start();
  await waitUntil(() => stamps.length >= 6, 3000);
  const gaps = stamps.slice(1).map((time, index) => time - stamps[index]);
  assert.ok(gaps[1] >= gaps[0] - 5, `delays should not shrink: ${gaps}`);
  assert.ok(gaps[gaps.length - 1] <= 120, `delay should be capped: ${gaps}`);
  assert.ok(warnings.length >= 1);

  gateway.stop();
  const attemptsAtStop = stamps.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(stamps.length, attemptsAtStop, 'no attempt after stop()');
  assert.equal(gateway.state, 'stopped');
});

test('the delay goes back to the minimum after a successful connection', async () => {
  const server = await startFakeServer((socket, count) => {
    if (count <= 2) setTimeout(() => socket.destroy(), 10);
  });
  const gateway = fastGateway(server.port, { minReconnectDelayMs: 10, maxReconnectDelayMs: 1000, backoffFactor: 10 });
  try {
    gateway.start();
    // the first two connections are dropped by the server, the third one stays
    await waitUntil(() => server.sockets.length >= 3 && gateway.connected, 3000);
    assert.equal(gateway.attempt, 0);
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('too many waiting commands are refused', async () => {
  const server = await startFakeServer();
  const gateway = fastGateway(server.port, { maxQueueLength: 2, sendIntervalMs: 500 });
  try {
    gateway.start();
    await once(gateway, 'connected');
    // Three commands in the same tick: the queue holds two, the third is refused.
    const first = gateway.send('*1*1*#15112945##');
    const second = gateway.send('*1*0*#15112945##');
    const third = gateway.send('*1*1*#15112946##');
    await assert.rejects(third, (error) => error instanceof GatewayError && error.code === 'QUEUE_FULL');
    await first; // goes out right away
    gateway.stop(); // the second one was still waiting for its turn
    await assert.rejects(second, (error) => error.code === 'STOPPED');
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('stop() closes the connection and rejects waiting commands', async () => {
  const server = await startFakeServer();
  const gateway = fastGateway(server.port, { sendIntervalMs: 400 });
  gateway.start();
  await once(gateway, 'connected');
  const first = gateway.send('*1*1*#15112945##');
  const second = gateway.send('*1*0*#15112945##');
  await first;
  const closed = new Promise((resolve) => server.sockets[0].once('close', resolve));
  gateway.stop();
  await assert.rejects(second, (error) => error.code === 'STOPPED');
  await closed;
  assert.equal(gateway.state, 'stopped');
  await server.close();
});

test('a failing frame listener does not break the connection', async () => {
  const server = await startFakeServer((socket) => socket.write('*1*1*0#15112945##*1*0*0#15112945##'));
  const gateway = fastGateway(server.port);
  const warnings = collect(gateway, 'warning');
  let calls = 0;
  gateway.on('frame', () => {
    calls += 1;
    throw new Error('listener bug');
  });
  try {
    gateway.start();
    await waitUntil(() => calls === 2);
    assert.equal(warnings.length, 2);
    assert.equal(gateway.connected, true);
  } finally {
    gateway.stop();
    await server.close();
  }
});

// ---- answers of the interface (*#*1## accepted, *#*0## refused) ------------------------

/** A fake 882 13 that answers each frame it receives from `answers` (default: accepted). */
async function startAnsweringServer(answers = []) {
  const received = [];
  const server = await startFakeServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let end;
      while ((end = buffer.indexOf('##')) >= 0) {
        const frame = buffer.slice(0, end + 2);
        buffer = buffer.slice(end + 2);
        received.push({ frame, at: performance.now() });
        const answer = answers.length > 0 ? answers.shift() : 'ack';
        if (answer === 'ack') socket.write('*#*1##');
        else if (answer === 'nack') socket.write('*#*0##');
        // 'none': no answer
      }
    });
  });
  return { ...server, received };
}

function answeringGateway(port, options = {}) {
  return fastGateway(port, { ackTimeoutMs: 1000, retryDelayMs: 50, maxRetries: 3, sendIntervalMs: 20, ...options });
}

test('a command resolves only once the interface has accepted it', async () => {
  const server = await startAnsweringServer(['ack']);
  const gateway = answeringGateway(server.port);
  try {
    gateway.start();
    await once(gateway, 'connected');
    await gateway.setLight({ legrandId: 944559, unit: 1, on: true });
    assert.deepEqual(server.received.map((r) => r.frame), ['*1*1*#15112945##']);
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('the next frame waits for the answer to the previous one, then the pause', async () => {
  const server = await startAnsweringServer(['ack', 'ack', 'ack']);
  const gateway = answeringGateway(server.port, { sendIntervalMs: 80 });
  try {
    gateway.start();
    await once(gateway, 'connected');
    await Promise.all([
      gateway.setLight({ legrandId: 944559, unit: 1, on: true }),
      gateway.setLight({ legrandId: 944559, unit: 2, on: true }),
      gateway.setLight({ legrandId: 944560, unit: 1, on: true }),
    ]);
    const times = server.received.map((r) => r.at);
    assert.equal(times.length, 3);
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i] - times[i - 1] >= 70, `gap ${times[i] - times[i - 1]} ms`);
    }
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('a refused frame is sent again after a delay, and the command then succeeds', async () => {
  const server = await startAnsweringServer(['nack', 'nack', 'ack']);
  const gateway = answeringGateway(server.port, { retryDelayMs: 60 });
  try {
    gateway.start();
    await once(gateway, 'connected');
    await gateway.setLight({ legrandId: 944559, unit: 2, on: false });
    assert.deepEqual(server.received.map((r) => r.frame), ['*1*0*#15112946##', '*1*0*#15112946##', '*1*0*#15112946##']);
    assert.ok(server.received[1].at - server.received[0].at >= 50, 'retry waits retryDelayMs');
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('a frame refused every time fails with REFUSED after maxRetries new tries', async () => {
  const server = await startAnsweringServer(['nack', 'nack', 'nack', 'nack', 'nack']);
  const gateway = answeringGateway(server.port, { maxRetries: 2 });
  try {
    gateway.start();
    await once(gateway, 'connected');
    await assert.rejects(gateway.setLight({ legrandId: 944559, unit: 2, on: true }), { name: 'GatewayError', code: 'REFUSED' });
    assert.equal(server.received.length, 3); // 1 + 2 retries
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('a refused frame does not hold back the commands behind it once it fails', async () => {
  const server = await startAnsweringServer(['nack', 'nack', 'ack']);
  const gateway = answeringGateway(server.port, { maxRetries: 1 });
  try {
    gateway.start();
    await once(gateway, 'connected');
    const first = gateway.setLight({ legrandId: 944559, unit: 1, on: true });
    const second = gateway.setLight({ legrandId: 944559, unit: 2, on: true });
    await assert.rejects(first, { code: 'REFUSED' });
    await second;
    assert.deepEqual(server.received.map((r) => r.frame), ['*1*1*#15112945##', '*1*1*#15112945##', '*1*1*#15112946##']);
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('with no answer in time, the written command counts as sent', async () => {
  const server = await startAnsweringServer(['none', 'ack']);
  const gateway = answeringGateway(server.port, { ackTimeoutMs: 80 });
  try {
    gateway.start();
    await once(gateway, 'connected');
    await gateway.setLight({ legrandId: 944559, unit: 1, on: true });
    await gateway.setLight({ legrandId: 944559, unit: 2, on: true });
    assert.equal(server.received.length, 2);
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('a command waiting for its answer is rejected when the connection drops', async () => {
  const server = await startAnsweringServer(['none']);
  const gateway = answeringGateway(server.port, { ackTimeoutMs: 2000 });
  try {
    gateway.start();
    await once(gateway, 'connected');
    const pending = gateway.setLight({ legrandId: 944559, unit: 1, on: true });
    await waitUntil(() => server.received.length === 1);
    server.sockets[0].destroy();
    await assert.rejects(pending, { code: 'DISCONNECTED' });
  } finally {
    gateway.stop();
    await server.close();
  }
});

test('a command sent while another waits for its answer is not written before that answer', async () => {
  const server = await startAnsweringServer(['none', 'ack']);
  const gateway = answeringGateway(server.port, { ackTimeoutMs: 150 });
  try {
    gateway.start();
    await once(gateway, 'connected');
    const first = gateway.setLight({ legrandId: 944559, unit: 1, on: true });
    await waitUntil(() => server.received.length === 1);
    const second = gateway.setLight({ legrandId: 944559, unit: 2, on: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(server.received.length, 1, 'still waiting for the first answer');
    await Promise.all([first, second]);
    assert.equal(server.received.length, 2);
  } finally {
    gateway.stop();
    await server.close();
  }
});
