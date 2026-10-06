'use strict';
// Fans access units from the pattern encoder and frames from the audio encoder out to every
// established DTLS client as two RTP streams (video PT_H264 / audio PT_PCMU) multiplexed onto the
// same channel, each with its own SSRC. Media is only ever sent on channels whose DTLS handshake
// has completed.

const { RtpPacketizer, PT_H264, PT_OPUS, PT_H264_OLD, PT_OPUS_OLD, encodeControl } = require('camera-shared');

const REPLAY_TICK_MS = 10;

class Streamer {
  constructor({ videoEncoder, audioEncoder, replay, log }) {
    this.videoEncoder = videoEncoder;
    this.replay = replay; // { maxGapMs, speed }
    this.replayClip = null; // set by setReplayClip() once built
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

  setReplayClip(clip) { this.replayClip = clip; }

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
    this._stopReplay(c);
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
        for (const pkt of c.video.packetizer.packetizeAccessUnit(au.nals, au.timestamp, au.captureMs)) {
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
        for (const pkt of c.audio.packetizer.packetizeFrame(f.payload, f.timestamp, f.captureMs)) {
          channel.send(pkt);
          c.packets++;
          c.bytes += pkt.length;
        }
      } catch (err) {
        this.log('warn', `audio send to ${c.label} failed: ${err.message}`);
      }
    }
  }

  /**
   * Host asked for the media it missed while offline: send the fake clip, re-stamped so it covers
   * [fromMs, toMs] of the camera's own clock, on separate payload types (PT_*_OLD) and SSRCs.
   * Paced faster than real time so it does not hold up the live stream.
   */
  startReplay(channel, req) {
    const c = this.clients.get(channel);
    if (!c || channel.closed) return;
    this._stopReplay(c);
    const reply = (obj) => { if (!channel.closed) { try { channel.send(encodeControl({ reqId: req.reqId, ...obj })); } catch { /* closing */ } } };
    const clip = this.replayClip;
    const fromMs = Number(req.fromMs);
    const now = Date.now();
    const toMs = Math.min(req.toMs === undefined ? now : Number(req.toMs), now);
    if (!clip || !Number.isFinite(fromMs) || !(toMs > fromMs)) {
      this.log('warn', `sync from ${c.label} rejected (from=${req.fromMs}, to=${req.toMs}, clip ${clip ? 'ready' : 'not ready'})`);
      reply({ type: 'sync_done', videoFrames: 0, audioFrames: 0, fromMs: req.fromMs, toMs });
      return;
    }
    // Keep the most recent part of an overlong gap.
    const startMs = Math.max(fromMs, toMs - this.replay.maxGapMs);
    const spanMs = toMs - startMs;
    const video = { packetizer: new RtpPacketizer({ payloadType: PT_H264_OLD }), i: 0, sent: 0 };
    const audio = { packetizer: new RtpPacketizer({ payloadType: PT_OPUS_OLD }), i: 0, sent: 0 };
    const vN = clip.video.length;
    const aN = clip.audio.length;
    const loopTs = (loop, n, per) => loop * n * per; // RTP timestamp base of the n-th loop pass
    const nextVideo = () => {
      const loop = Math.floor(video.i / vN);
      const u = clip.video[video.i % vN];
      return { t: loop * clip.durationMs + u.offsetMs, u, loop };
    };
    const nextAudio = () => {
      const loop = Math.floor(audio.i / aN);
      const u = clip.audio[audio.i % aN];
      return { t: loop * clip.durationMs + u.offsetMs, u, loop };
    };
    this.log('info', `sync for ${c.label}: replaying ${new Date(startMs).toISOString()} .. ${new Date(toMs).toISOString()} (${spanMs} ms)`);

    const sendPackets = (pkts) => { for (const pkt of pkts) { channel.send(pkt); c.packets++; c.bytes += pkt.length; } };
    const t0 = Date.now();
    const state = { timer: null };
    c.replayState = state;
    const finish = () => {
      clearInterval(state.timer);
      if (c.replayState === state) c.replayState = null;
      this.log('info', `sync for ${c.label} done: ${video.sent} video frame(s), ${audio.sent} audio frame(s)`);
      reply({ type: 'sync_done', videoFrames: video.sent, audioFrames: audio.sent, fromMs: startMs, toMs });
    };
    state.timer = setInterval(() => {
      if (channel.closed) { clearInterval(state.timer); return; }
      const virtual = Math.min((Date.now() - t0) * this.replay.speed, spanMs);
      try {
        for (;;) {
          const v = nextVideo();
          const a = nextAudio();
          const useVideo = v.t <= a.t;
          const cur = useVideo ? v : a;
          if (cur.t >= spanMs || cur.t > virtual) break;
          if (useVideo) {
            sendPackets(video.packetizer.packetizeAccessUnit(v.u.nals, (v.u.timestamp + loopTs(v.loop, vN, clip.ticksPerFrame)) >>> 0, startMs + v.t));
            video.i++; video.sent++;
          } else {
            sendPackets(audio.packetizer.packetizeFrame(a.u.payload, (a.u.timestamp + loopTs(a.loop, aN, 960)) >>> 0, startMs + a.t));
            audio.i++; audio.sent++;
          }
        }
      } catch (err) {
        this.log('warn', `replay to ${c.label} failed: ${err.message}`);
        finish();
        return;
      }
      if (virtual >= spanMs) finish();
    }, REPLAY_TICK_MS);
  }

  _stopReplay(c) {
    if (c.replayState) { clearInterval(c.replayState.timer); c.replayState = null; }
  }
}

module.exports = { Streamer };
