'use strict';
// DTLS 1.3 client transport for one camera: UDP socket + wolfSSL session, with handshake
// timeout, keepalives, idle detection and reconnect with exponential backoff.

const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { DtlsChannel } = require('wolfssl-dtls');
const { MSG_CONTROL, encodeControl, decodeControl } = require('camera-shared');

const KEEPALIVE = Buffer.from([0x01]); // application-level ping (RTP packets start with 0x80)

class CameraClient extends EventEmitter {
  /**
   * Events: 'state' (state, detail), 'connected' (dtlsInfo), 'disconnected' (reason), 'rtp' (Buffer),
   * 'control' (object, a control message from the camera)
   */
  constructor({ host, port, serverName, ca, transport, log }) {
    super();
    Object.assign(this, { host, port, serverName, ca, transport, log });
    this.state = 'stopped'; // stopped | connecting | connected | reconnecting
    this.reconnects = 0;
    this.lastError = null;
    this._stopped = true;
    this._backoff = transport.minBackoffMs;
    this._sock = null;
    this._channel = null;
    this._timers = [];
    this._retry = null;
    this._lastRx = 0;
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect(false);
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._retry);
    this._teardown('stopped', false);
    this._setState('stopped');
  }

  _setState(state, detail) {
    if (this.state === state && detail === undefined) return;
    this.state = state;
    this.emit('state', state, detail);
  }

  _connect(isRetry) {
    this._setState(isRetry ? 'reconnecting' : 'connecting');
    const sock = dgram.createSocket('udp4');
    this._sock = sock;
    let gone = false;
    const fail = (reason) => {
      if (gone) return;
      gone = true;
      this.lastError = reason;
      this._teardown(reason, true);
    };

    // A connected UDP socket only accepts datagrams from the camera; ICMP errors surface as 'error'.
    sock.on('error', (err) => fail(`socket error: ${err.message}`));
    sock.connect(this.port, this.host, () => {
      if (gone || this._sock !== sock) return;
      const channel = new DtlsChannel(
        { role: 'client', ca: this.ca, serverName: this.serverName, verifyPeer: true },
        (datagram) => { try { sock.send(datagram); } catch { /* socket closing */ } },
      );
      this._channel = channel;
      sock.on('message', (msg) => {
        this._lastRx = Date.now();
        try { channel.receive(msg); } catch (err) { fail(`DTLS failure: ${err.message}`); }
      });
      channel.on('established', (info) => {
        this._backoff = this.transport.minBackoffMs;
        this._lastRx = Date.now();
        this.lastError = null;
        this.log('info', `DTLS established: ${info.version}, cipher ${info.cipher}, group ${info.group}, ` +
          `cert signature ${info.signature}, peer ${info.peerSubject}`);
        this._startTimers(fail);
        this._setState('connected');
        this.emit('connected', info);
      });
      channel.on('data', (d) => {
        if (d.length > 12 && d[0] >> 6 === 2) this.emit('rtp', d);
        else if (d[0] === MSG_CONTROL) { const msg = decodeControl(d); if (msg) this.emit('control', msg); }
      });
      channel.on('error', (err) => { this.lastError = err.message; this.log('warn', err.message); });
      channel.on('close', () => fail('DTLS session closed'));

      this._timers.push(setTimeout(() => {
        if (!channel.established) fail('DTLS handshake timed out');
      }, this.transport.handshakeTimeoutMs));
      this.log('info', `starting DTLS 1.3 handshake with ${this.host}:${this.port}`);
      try { channel.start(); } catch (err) { fail(err.message); }
    });
  }

  /** Send an application control message to the camera. @returns {boolean} false when not connected */
  sendControl(obj) {
    const ch = this._channel;
    if (this.state !== 'connected' || !ch || ch.closed) return false;
    try { ch.send(encodeControl(obj)); return true; } catch { return false; }
  }

  _startTimers(fail) {
    const ch = this._channel;
    this._timers.push(setInterval(() => {
      if (!ch.closed) { try { ch.send(KEEPALIVE); } catch { /* handled by close */ } }
    }, this.transport.keepaliveMs));
    this._timers.push(setInterval(() => {
      if (Date.now() - this._lastRx > this.transport.idleTimeoutMs) fail('no data from camera (idle timeout)');
    }, 1000));
  }

  _teardown(reason, retry) {
    for (const t of this._timers) { clearTimeout(t); clearInterval(t); }
    this._timers = [];
    const ch = this._channel;
    const sock = this._sock;
    this._channel = null;
    this._sock = null;
    const wasConnected = this.state === 'connected';
    if (ch && !ch.closed) { try { ch.close(); } catch { /* ignore */ } }
    if (sock) { try { sock.close(); } catch { /* already closed */ } }
    if (wasConnected) this.emit('disconnected', reason);
    if (retry && !this._stopped) {
      this.reconnects++;
      this.log('warn', `${reason}; reconnecting in ${this._backoff} ms`);
      this._setState('reconnecting', reason);
      this._retry = setTimeout(() => this._connect(true), this._backoff);
      this._backoff = Math.min(this._backoff * 2, this.transport.maxBackoffMs);
    }
  }
}

module.exports = { CameraClient };
