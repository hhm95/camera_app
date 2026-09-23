'use strict';
// JS wrapper around the wolfSSL N-API addon. It owns the retransmission timer and turns the
// datagram-in/datagram-out state machine into an EventEmitter bound to a `sendDatagram` function
// (typically socket.send to a fixed peer).

const { EventEmitter } = require('node:events');
const path = require('node:path');

const native = require(path.join(__dirname, 'build', 'Release', 'wolfssl_dtls.node'));

// wolfSSL's CTC_ED25519 sum for the peer certificate's signature algorithm (1.3.101.112),
// in the OID-sum form used with and without WOLFSSL_OLD_OID_SUM.
const CTC_ED25519 = new Set([256, 0x7f8f65d4]);

class DtlsChannel extends EventEmitter {
  /**
   * @param {object} opts  { role, cert, key, ca, verifyPeer, serverName }
   * @param {(datagram: Buffer) => void} sendDatagram
   */
  constructor(opts, sendDatagram) {
    super();
    this._session = new native.DtlsSession(opts);
    this._sendDatagram = sendDatagram;
    this._timer = null;
    this._established = false;
    this._closed = false;
    this.role = opts.role;
  }

  get established() { return this._established; }
  get closed() { return this._closed; }

  /** Client only: send ClientHello. */
  start() {
    this._handle(this._session.startHandshake());
  }

  /** Feed one UDP datagram received from the peer. */
  receive(datagram) {
    if (this._closed) return;
    this._handle(this._session.feed(datagram));
  }

  /** Encrypt and send application data (one call == one DTLS record). */
  send(data) {
    if (this._closed) throw new Error('DTLS channel closed');
    this._flush(this._session.write(data));
    this._schedule();
  }

  /** Negotiated parameters, as reported by wolfSSL. */
  info() {
    const i = this._session.info();
    if (i.peerCertSignatureType !== undefined) {
      i.signature = CTC_ED25519.has(i.peerCertSignatureType) ? 'Ed25519' : `oid-sum:${i.peerCertSignatureType}`;
    }
    return i;
  }

  close() {
    if (this._closed) return;
    try { this._flush(this._session.close()); } catch { /* ignore */ }
    this._dispose();
    this.emit('close');
  }

  _handle(res) {
    this._flush(res.out);
    for (const d of res.data) this.emit('data', d);
    if (res.established && !this._established) {
      this._established = true;
      this.emit('established', this.info());
    }
    if (res.error) {
      const err = new Error(`DTLS error: ${res.error}`);
      this._dispose();
      this.emit('error', err);
      this.emit('close');
      return;
    }
    if (res.closed) {
      this._dispose();
      this.emit('close');
      return;
    }
    this._schedule();
  }

  _flush(datagrams) {
    for (const d of datagrams) this._sendDatagram(d);
  }

  _schedule() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._closed) return;
    if (!this._session.needsTimer()) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._closed) return;
      this._handle(this._session.handleTimeout());
    }, this._session.nextTimeoutMs());
    this._timer.unref?.();
  }

  _dispose() {
    this._closed = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._session.free();
  }
}

module.exports = { DtlsChannel, DtlsSession: native.DtlsSession, wolfsslVersion: native.wolfsslVersion };
