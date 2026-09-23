'use strict';
// Fans access units from the pattern encoder out to every established DTLS client as RTP/H.264.
// Media is only ever sent on channels whose DTLS handshake has completed.

const { RtpPacketizer } = require('camera-shared');

class Streamer {
  constructor({ encoder, log }) {
    this.encoder = encoder;
    this.log = log;
    this.clients = new Map(); // channel -> { packetizer, waitingForKey, stats }
    this.encoder.on('au', (au) => this._onAccessUnit(au));
    this.encoder.on('exit', ({ code, stderr }) => {
      if (this.clients.size) this.log('warn', `encoder exited (code ${code}) ${stderr.trim()}`);
    });
  }

  addClient(channel, label) {
    this.clients.set(channel, {
      label,
      packetizer: new RtpPacketizer(),
      waitingForKey: true, // a client must start on an IDR access unit
      packets: 0,
      bytes: 0,
    });
    this.log('info', `streaming to ${label} (${this.clients.size} client(s))`);
    if (!this.encoder.running) this.encoder.start();
  }

  removeClient(channel) {
    const c = this.clients.get(channel);
    if (!c) return;
    this.clients.delete(channel);
    this.log('info', `stopped streaming to ${c.label}: ${c.packets} packets, ${c.bytes} bytes`);
    if (this.clients.size === 0) this.encoder.stop();
  }

  _onAccessUnit(au) {
    for (const [channel, c] of this.clients) {
      if (c.waitingForKey) {
        if (!au.idr) continue;
        c.waitingForKey = false;
      }
      if (channel.closed) continue;
      try {
        for (const pkt of c.packetizer.packetizeAccessUnit(au.nals, au.timestamp)) {
          channel.send(pkt);
          c.packets++;
          c.bytes += pkt.length;
        }
      } catch (err) {
        this.log('warn', `send to ${c.label} failed: ${err.message}`);
      }
    }
  }
}

module.exports = { Streamer };
