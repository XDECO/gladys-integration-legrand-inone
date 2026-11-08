/*
 * TCP client for the serial-to-TCP gateway in front of the Legrand 882 13.
 *
 * Responsibilities:
 *   - keep a connection open, reconnecting with a growing delay when it drops;
 *   - split the incoming stream into frames and emit them parsed;
 *   - send frames one at a time, with a minimum delay between two writes;
 *   - NEVER keep a command waiting while disconnected: a light command that
 *     executes minutes late (after a reconnection) would be a bad surprise, so
 *     commands are rejected immediately when there is no connection, and any
 *     command still waiting when the connection drops is rejected too.
 *
 * Events (EventEmitter):
 *   'state'        (state)   'stopped' | 'connecting' | 'connected' | 'waiting'
 *   'connected'    ()
 *   'disconnected' ()        only if the connection had been established
 *   'frame'        (frame)   a frame parsed by parseFrame()
 *   'warning'      (error)   socket error, listener error (never throws)
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { FrameDecoder, parseFrame, encodeLightCommand } from './protocol.js';

export class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
  }
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Delay before reconnection attempt number `attempt` (0 for the first one). */
export function backoffDelay(attempt, { minDelayMs, maxDelayMs, factor }) {
  return Math.min(maxDelayMs, minDelayMs * factor ** attempt);
}

// A frame starts with "*", contains only digits, "*" and "#", and ends with "##".
const FRAME_RE = /^\*[0-9*#]+##$/;

export class LegrandGateway extends EventEmitter {
  constructor({
    host,
    port,
    sendIntervalMs = 200,
    maxQueueLength = 50,
    connectTimeoutMs = 5000,
    minReconnectDelayMs = 1000,
    maxReconnectDelayMs = 30000,
    backoffFactor = 2,
    connect = net.createConnection,
    logger = noopLogger,
  } = {}) {
    super();
    if (typeof host !== 'string' || host === '') {
      throw new TypeError('host is required');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RangeError(`Invalid port: ${port}`);
    }
    this.host = host;
    this.port = port;
    this.sendIntervalMs = sendIntervalMs;
    this.maxQueueLength = maxQueueLength;
    this.connectTimeoutMs = connectTimeoutMs;
    this.backoff = {
      minDelayMs: minReconnectDelayMs,
      maxDelayMs: maxReconnectDelayMs,
      factor: backoffFactor,
    };
    this.connectFn = connect;
    this.logger = logger;

    this.state = 'stopped';
    this.socket = null;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.pumpTimer = null;
    this.lastWriteAt = Number.NEGATIVE_INFINITY;
    this.queue = [];
    this.decoder = new FrameDecoder();
  }

  get connected() {
    return this.state === 'connected';
  }

  /** Start connecting (and keep reconnecting) until stop() is called. */
  start() {
    if (this.state !== 'stopped') return;
    this.#connect();
  }

  /** Close the connection, cancel any reconnection, reject waiting commands. */
  stop() {
    this.#clearTimers();
    this.#rejectQueue(new GatewayError('STOPPED', 'Gateway stopped'));
    const { socket } = this;
    this.socket = null;
    if (socket) socket.destroy();
    this.#setState('stopped');
  }

  /**
   * Send one raw frame. Resolves once the frame has been written to the socket,
   * rejects with a GatewayError otherwise (NOT_CONNECTED, QUEUE_FULL,
   * INVALID_FRAME, DISCONNECTED, STOPPED, WRITE_FAILED).
   */
  send(frame) {
    return new Promise((resolve, reject) => {
      if (typeof frame !== 'string' || !FRAME_RE.test(frame)) {
        reject(new GatewayError('INVALID_FRAME', `Invalid frame: ${String(frame)}`));
        return;
      }
      if (this.state !== 'connected') {
        reject(new GatewayError('NOT_CONNECTED', 'Not connected to the gateway'));
        return;
      }
      if (this.queue.length >= this.maxQueueLength) {
        reject(new GatewayError('QUEUE_FULL', 'Too many commands waiting'));
        return;
      }
      this.queue.push({ frame, resolve, reject });
      this.#pump();
    });
  }

  /** Switch a light circuit on or off. */
  async setLight({ legrandId, unit, on }) {
    return this.send(encodeLightCommand({ legrandId, unit, on }));
  }

  // ---- internals -----------------------------------------------------------

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.#emitSafe('state', state);
  }

  #emitSafe(event, ...args) {
    try {
      this.emit(event, ...args);
    } catch (error) {
      this.logger.error(`Listener for "${event}" threw: ${error.message}`);
      try {
        this.emit('warning', error);
      } catch {
        // a failing warning listener must not take the process down
      }
    }
  }

  #clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.reconnectTimer = null;
    this.pumpTimer = null;
  }

  #rejectQueue(error) {
    const waiting = this.queue.splice(0);
    for (const item of waiting) item.reject(error);
  }

  #connect() {
    this.#setState('connecting');
    this.logger.debug(`Connecting to ${this.host}:${this.port}`);

    const socket = this.connectFn({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);

    const connectTimer = setTimeout(() => {
      socket.destroy(new Error(`Connection timeout after ${this.connectTimeoutMs} ms`));
    }, this.connectTimeoutMs);

    let established = false;

    socket.once('connect', () => {
      clearTimeout(connectTimer);
      established = true;
      socket.setKeepAlive(true, 30000);
      this.attempt = 0;
      this.decoder.reset(); // never glue a half frame from the old connection
      this.logger.info(`Connected to ${this.host}:${this.port}`);
      this.#setState('connected');
      this.#emitSafe('connected');
    });

    socket.on('data', (chunk) => {
      for (const raw of this.decoder.push(chunk)) {
        this.#emitSafe('frame', parseFrame(raw));
      }
    });

    socket.on('error', (error) => {
      this.logger.warn(`Gateway socket error: ${error.message}`);
      this.#emitSafe('warning', error);
    });

    socket.once('close', () => {
      clearTimeout(connectTimer);
      if (this.socket !== socket) return; // already replaced or stopped
      this.socket = null;
      if (this.pumpTimer) clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
      this.#rejectQueue(new GatewayError('DISCONNECTED', 'Connection to the gateway lost'));
      if (established) {
        this.logger.warn('Disconnected from the gateway');
        this.#emitSafe('disconnected');
      }
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    const delay = backoffDelay(this.attempt, this.backoff);
    this.attempt += 1;
    this.#setState('waiting');
    this.logger.debug(`Reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #pump() {
    if (this.pumpTimer || this.queue.length === 0 || this.state !== 'connected') return;
    const wait = Math.max(0, this.lastWriteAt + this.sendIntervalMs - performance.now());
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.#writeNext();
    }, wait);
  }

  #writeNext() {
    const item = this.queue.shift();
    if (!item) return;
    if (this.state !== 'connected' || !this.socket) {
      item.reject(new GatewayError('DISCONNECTED', 'Connection to the gateway lost'));
      return;
    }
    this.lastWriteAt = performance.now();
    this.logger.debug(`TX ${item.frame}`);
    this.socket.write(item.frame, 'latin1', (error) => {
      if (error) item.reject(new GatewayError('WRITE_FAILED', error.message));
      else item.resolve();
    });
    this.#pump();
  }
}
