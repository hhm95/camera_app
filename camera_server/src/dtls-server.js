'use strict';
// UDP listener that demultiplexes datagrams into per-peer wolfSSL DTLS 1.3 sessions.

const dgram = require('node:dgram');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { DtlsChannel } = require('wolfssl-dtls');

const DTLS_HANDSHAKE = 22; // record content type of a plaintext ClientHello

class DtlsServer extends EventEmitter {
  constructor({ host, port, certFile, keyFile, maxClients, handshakeTimeoutMs, idleTimeoutMs, log }) {
    super();
    this.host = host;
    this.port = port;
    this.cert = fs.readFileSync(certFile);
    this.key = fs.readFileSync(keyFile);
    this.maxClients = maxClients;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.log = log;
    this.sessions = new Map(); // "ip:port" -> { channel, lastRx, createdAt, rinfo }
    this.socket = null;
    this._sweeper = null;
  }

  listen() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      this.socket = sock;
      sock.on('message', (msg, rinfo) => this._onDatagram(msg, rinfo));
      sock.on('error', (err) => { this.emit('error', err); reject(err); });
      sock.bind(this.port, this.host, () => {
        this._sweeper = setInterval(() => this._sweep(), 1000);
        resolve(sock.address());
      });
    });
  }

  _onDatagram(msg, rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    let s = this.sessions.get(key);
    if (s && s.channel.established && msg[0] === DTLS_HANDSHAKE) {
      // Established DTLS 1.3 traffic uses the unified header (0x2X); a plaintext handshake record
      // from the same address:port means the peer restarted and wants a fresh session.
      this.log('info', `${key} sent a new ClientHello, replacing the existing session`);
      this._drop(key);
      s = undefined;
    }
    if (!s) {
      // Only a ClientHello may open a session: ignore anything else (scans, stray packets).
      if (msg[0] !== DTLS_HANDSHAKE) return;
      if (this.sessions.size >= this.maxClients) {
        this.log('warn', `rejecting ${key}: max clients (${this.maxClients}) reached`);
        return;
      }
      s = this._createSession(key, rinfo);
    }
    s.lastRx = Date.now();
    try {
      s.channel.receive(msg);
    } catch (err) {
      this.log('error', `session ${key}: ${err.message}`);
      this._drop(key);
    }
  }

  _createSession(key, rinfo) {
    const channel = new DtlsChannel(
      { role: 'server', cert: this.cert, key: this.key },
      (datagram) => this.socket.send(datagram, rinfo.port, rinfo.address),
    );
    const s = { key, channel, rinfo, createdAt: Date.now(), lastRx: Date.now() };
    this.sessions.set(key, s);
    this.log('info', `new DTLS session from ${key}, handshake starting`);

    channel.on('established', (info) => {
      this.log('info', `DTLS established with ${key}: ${info.version}, cipher ${info.cipher}, group ${info.group}, ` +
        'authenticated with the Ed25519 server certificate');
      this.emit('client', channel, key);
    });
    channel.on('data', (data) => this.emit('clientData', channel, key, data));
    channel.on('error', (err) => this.log('warn', `session ${key}: ${err.message}`));
    channel.on('close', () => {
      if (this.sessions.get(key) === s) this.sessions.delete(key);
      this.log('info', `session ${key} closed`);
      this.emit('clientClosed', channel, key);
    });
    return s;
  }

  _drop(key) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    s.channel.close();
  }

  _sweep() {
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      if (!s.channel.established && now - s.createdAt > this.handshakeTimeoutMs) {
        this.log('warn', `session ${key}: handshake timed out`);
        this._drop(key);
      } else if (s.channel.established && now - s.lastRx > this.idleTimeoutMs) {
        this.log('warn', `session ${key}: idle for ${this.idleTimeoutMs} ms, closing`);
        this._drop(key);
      }
    }
  }

  close() {
    clearInterval(this._sweeper);
    for (const key of [...this.sessions.keys()]) this._drop(key);
    return new Promise((resolve) => (this.socket ? this.socket.close(resolve) : resolve()));
  }
}

module.exports = { DtlsServer };
