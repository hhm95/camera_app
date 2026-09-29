'use strict';
// Fans access units from the pattern encoder and frames from the audio encoder out to every
// established DTLS client as two RTP streams (video PT_H264 / audio PT_PCMU) multiplexed onto the
// same channel, each with its own SSRC. Media is only ever sent on channels whose DTLS handshake
// has completed.

const { RtpPacketizer, PT_H264, PT_OPUS } = require('camera-shared');

class Streamer {
  constructor({ videoEncoder, audioEncoder, log }) {
    this.videoEncoder = videoEncoder;
    this.audioEncoder = audioEncoder;
    this.log = log;
    this.clients = new Map(); // channel -> { label, video: {...}, audio: {...}, packets, bytes }
    this.videoEncoder.on('au', (au) => this._onAccessUnit(au));
    this.videoEncoder.on('exit', ({ code, stderr }) => {
      if (this.clients.size) this.log('warn', `video encoder exited (code ${code}) ${stderr.trim()}`);
    });
    this.audioEncoder.on('frame', (f) => this._onAudioFrame(f));
    this.audioEncoder.on('exit', ({ code, stderr }) => {
      if (this.clients.size) this.log('warn', `audio encoder exited (code ${code}) ${stderr.trim()}`);
    });
  }

  addClient(channel, label) {
    this.clients.set(channel, {
      label,
      video: { packetizer: new RtpPacketizer({ payloadType: PT_H264 }), waitingForKey: true },
      audio: { packetizer: new RtpPacketizer({ payloadType: PT_OPUS }) },
      packets: 0,
      bytes: 0,
    });
    this.log('info', `streaming to ${label} (${this.clients.size} client(s))`);
    if (!this.videoEncoder.running) this.videoEncoder.start();
    if (!this.audioEncoder.running) this.audioEncoder.start();
  }

  removeClient(channel) {
    const c = this.clients.get(channel);
    if (!c) return;
    this.clients.delete(channel);
    this.log('info', `stopped streaming to ${c.label}: ${c.packets} packets, ${c.bytes} bytes`);
    if (this.clients.size === 0) {
      this.videoEncoder.stop();
      this.audioEncoder.stop();
    }
  }

  _onAccessUnit(au) {
    for (const [channel, c] of this.clients) {
      if (c.video.waitingForKey) {
        if (!au.idr) continue;
        c.video.waitingForKey = false;
      }
      if (channel.closed) continue;
      try {
        for (const pkt of c.video.packetizer.packetizeAccessUnit(au.nals, au.timestamp)) {
          channel.send(pkt);
          c.packets++;
          c.bytes += pkt.length;
        }
      } catch (err) {
        this.log('warn', `video send to ${c.label} failed: ${err.message}`);
      }
    }
  }

  _onAudioFrame(f) {
    for (const [channel, c] of this.clients) {
      if (channel.closed) continue;
      try {
        for (const pkt of c.audio.packetizer.packetizeFrame(f.payload, f.timestamp)) {
          channel.send(pkt);
          c.packets++;
          c.bytes += pkt.length;
        }
      } catch (err) {
        this.log('warn', `audio send to ${c.label} failed: ${err.message}`);
      }
    }
  }
}

module.exports = { Streamer };
