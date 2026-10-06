'use strict';
// One camera on the host: DTLS transport -> RTP depacketizer -> (recorder, decoder) -> live frame.

const { EventEmitter } = require('node:events');
const { RtpDepacketizer, RtpFrameDepacketizer, parseRtp, toAnnexB, nalType, NAL, PT_H264, PT_OPUS, PT_H264_OLD, PT_OPUS_OLD } = require('camera-shared');
const { CameraClient } = require('./camera-client');
const { JpegDecoder, jpegSize } = require('./decoder');
const { CameraStorage } = require('./storage');

const STATS_WINDOW_MS = 5000;

class Camera extends EventEmitter {
  constructor(cfg, { caPem, dataDir, ffmpeg, storage, transport, log }) {
    super();
    this.id = cfg.id;
    this.name = cfg.name || cfg.id;
    this.host = cfg.host;
    this.port = cfg.port;
    this.log = (level, msg) => log(level, `[${this.id}] ${msg}`);

    this.client = new CameraClient({
      host: cfg.host, port: cfg.port, serverName: cfg.serverName, ca: caPem, transport, log: this.log,
    });
    this.decoder = new JpegDecoder({ ffmpeg, log: this.log });
    this.storage = new CameraStorage({ dataDir, cameraId: this.id, ...storage, log: this.log });
    this.dataDir = dataDir;

    this.dtls = null;
    this.connectedSince = null;
    this.latestFrame = null;
    this.latestFrameAt = null;
    this.resolution = null;
    this.framesReceived = 0;
    this.framesDecoded = 0;
    this.framesDropped = 0;
    this.audioFramesReceived = 0;
    this.unknownPayloadType = 0;
    this.videoRtp = new RtpDepacketizer();
    this.audioRtp = new RtpFrameDepacketizer();
    this.oldVideoRtp = new RtpDepacketizer(); // replayed ("old") media has its own SSRCs / PTs
    this.oldAudioRtp = new RtpFrameDepacketizer();
    this.oldVideoFrames = 0;
    this.oldAudioFrames = 0;
    this.lastCaptureMs = null; // newest camera capture time received live (video or audio)
    this.lastVideoCaptureMs = null;
    this.lastAudioCaptureMs = null;
    this.syncFromMs = null; // set while a sync request is outstanding (not yet sync_done)
    this._syncSeq = 0;
    this._needKey = true;
    this._oldNeedKey = true;
    this._window = []; // { t, bytes } per access unit, for fps / bitrate
    this._audioWindow = []; // { t, bytes } per audio frame, for bitrate

    this.client.on('state', (state, detail) => this.emit('state', state, detail));
    this.client.on('connected', (info) => this._onConnected(info));
    this.client.on('disconnected', (reason) => this._onDisconnected(reason));
    this.client.on('rtp', (pkt) => this._onRtp(pkt));
    this.client.on('control', (msg) => this._onControl(msg));
    this.decoder.on('frame', (jpeg) => this._onFrame(jpeg));
  }

  start() {
    this.decoder.start();
    this.client.start();
  }

  stop() {
    this.client.stop();
    this.decoder.stop();
    this.storage.close();
  }

  _onConnected(info) {
    this.dtls = info;
    this.connectedSince = new Date();
    this.videoRtp = new RtpDepacketizer(); // new session => new RTP streams
    this.audioRtp = new RtpFrameDepacketizer();
    this.oldVideoRtp = new RtpDepacketizer();
    this.oldAudioRtp = new RtpFrameDepacketizer();
    this._needKey = true;
    this._oldNeedKey = true;
    this._window = [];
    this._audioWindow = [];
    this.decoder.reset();
    this.storage.event('connected', {
      dtls: { version: info.version, cipher: info.cipher, group: info.group, signature: info.signature, peer: info.peerSubject },
    });
    this._requestSync();
  }

  // Ask the camera for what we missed. `fromMs` is the camera's own clock (last capture time we
  // saw); no `toMs`, so the camera picks "now" and host/camera clock skew never matters. If the
  // previous sync was cut short by another outage, resume from where that one started.
  _requestSync() {
    const fromMs = this.syncFromMs ?? this.lastCaptureMs;
    if (fromMs === null) return; // first connection ever: nothing was missed
    const reqId = ++this._syncSeq;
    this.syncFromMs = fromMs;
    if (this.client.sendControl({ type: 'sync', reqId, fromMs })) {
      this.log('info', `requesting sync from ${new Date(fromMs).toISOString()}`);
      this.storage.event('sync_request', { reqId, fromMs, from: new Date(fromMs).toISOString() });
    }
  }

  _onControl(msg) {
    if (msg.type !== 'sync_done') return;
    this.storage.endOldSegments();
    this.syncFromMs = null;
    this.log('info', `sync done: ${msg.videoFrames} video / ${msg.audioFrames} audio frame(s)`);
    this.storage.event('sync_done', {
      reqId: msg.reqId, videoFrames: msg.videoFrames, audioFrames: msg.audioFrames,
      from: msg.fromMs && new Date(msg.fromMs).toISOString(), to: msg.toMs && new Date(msg.toMs).toISOString(),
    });
  }

  _onDisconnected(reason) {
    this.log('warn', `disconnected: ${reason}`);
    this.storage.endSegment();
    this.storage.event('disconnected', { reason });
    this.connectedSince = null;
  }

  // Demux by RTP payload type before any packet reaches a depacketizer: RtpDepacketizer resets
  // its reassembly state whenever the SSRC changes, so feeding it packets from both streams (or
  // feeding audio bytes into the H.264-aware NAL/STAP-A/FU-A parser) would corrupt both streams.
  _onRtp(pkt) {
    const rtp = parseRtp(pkt);
    if (!rtp) return;
    if (rtp.payloadType === PT_H264) {
      for (const au of this.videoRtp.push(pkt)) this._onVideoAu(au);
    } else if (rtp.payloadType === PT_OPUS) {
      for (const f of this.audioRtp.push(pkt)) this._onAudioFrame(f);
    } else if (rtp.payloadType === PT_H264_OLD) {
      for (const au of this.oldVideoRtp.push(pkt)) this._onOldVideoAu(au);
    } else if (rtp.payloadType === PT_OPUS_OLD) {
      for (const f of this.oldAudioRtp.push(pkt)) this._onOldAudioFrame(f);
    } else {
      this.unknownPayloadType++;
    }
  }

  // Replayed media goes to disk only: never to the live decoder / dashboard / needKey state.
  _onOldVideoAu(au) {
    const isIdr = au.nals.some((n) => nalType(n) === NAL.IDR);
    if (au.damaged || au.captureMs === null) { this._oldNeedKey = true; return; }
    if (this._oldNeedKey) {
      if (!isIdr) return;
      this._oldNeedKey = false;
    }
    this.oldVideoFrames++;
    this.storage.writeOldAccessUnit(toAnnexB(au.nals), isIdr, au.captureMs);
  }

  _onOldAudioFrame(f) {
    if (f.captureMs === null) return;
    this.oldAudioFrames++;
    this.storage.writeOldAudioFrame(f.payload, f.captureMs);
  }

  _noteCapture(kind, ms) {
    if (ms === null) return;
    if (kind === 'video') this.lastVideoCaptureMs = Math.max(this.lastVideoCaptureMs ?? 0, ms);
    else this.lastAudioCaptureMs = Math.max(this.lastAudioCaptureMs ?? 0, ms);
    this.lastCaptureMs = Math.max(this.lastCaptureMs ?? 0, ms);
  }

  _onVideoAu(au) {
    this._noteCapture('video', au.captureMs);
    this.framesReceived++;
    const isIdr = au.nals.some((n) => nalType(n) === NAL.IDR);
    if (au.damaged) {
      // packets were lost inside this picture: wait for the next IDR instead of feeding garbage
      this._needKey = true;
      this.framesDropped++;
      return;
    }
    if (this._needKey) {
      if (!isIdr) { this.framesDropped++; return; }
      this._needKey = false;
    }
    const annexB = toAnnexB(au.nals);
    this._window.push({ t: Date.now(), bytes: annexB.length });
    this.storage.writeAccessUnit(annexB, isIdr);
    this.decoder.write(annexB);
  }

  _onAudioFrame(f) {
    this._noteCapture('audio', f.captureMs);
    this.audioFramesReceived++;
    this._audioWindow.push({ t: Date.now(), bytes: f.payload.length });
    this.storage.writeAudioFrame(f.payload);
    this.emit('audioFrame', f.payload);
  }

  _onFrame(jpeg) {
    this.framesDecoded++;
    this.latestFrame = jpeg;
    this.latestFrameAt = new Date();
    if (!this.resolution) this.resolution = jpegSize(jpeg);
    this.storage.maybeSaveFrame(jpeg);
    this.emit('frame', jpeg);
  }

  status() {
    const now = Date.now();
    this._window = this._window.filter((s) => now - s.t <= STATS_WINDOW_MS);
    const span = this._window.length > 1 ? (this._window.at(-1).t - this._window[0].t) / 1000 : 0;
    const bytes = this._window.reduce((s, x) => s + x.bytes, 0);
    this._audioWindow = this._audioWindow.filter((s) => now - s.t <= STATS_WINDOW_MS);
    const audioSpan = this._audioWindow.length > 1 ? (this._audioWindow.at(-1).t - this._audioWindow[0].t) / 1000 : 0;
    const audioBytes = this._audioWindow.reduce((s, x) => s + x.bytes, 0);
    const c = this.client;
    return {
      id: this.id,
      name: this.name,
      state: c.state === 'connected' && this.latestFrameAt && now - this.latestFrameAt > 5000 ? 'stalled' : c.state,
      address: `${this.host}:${this.port}`,
      connectedSince: this.connectedSince && this.connectedSince.toISOString(),
      reconnects: c.reconnects,
      lastError: c.lastError,
      dtls: this.dtls && {
        version: this.dtls.version, cipher: this.dtls.cipher, group: this.dtls.group,
        signature: this.dtls.signature, peer: this.dtls.peerSubject,
      },
      video: {
        codec: 'H.264', resolution: this.resolution,
        fps: span > 0 ? Number(((this._window.length - 1) / span).toFixed(1)) : 0,
        bitrateKbps: span > 0 ? Math.round((bytes * 8) / span / 1000) : 0,
        framesReceived: this.framesReceived, framesDecoded: this.framesDecoded, framesDropped: this.framesDropped,
      },
      audio: {
        codec: 'Opus', sampleRate: 48000,
        bitrateKbps: audioSpan > 0 ? Math.round((audioBytes * 8) / audioSpan / 1000) : 0,
        framesReceived: this.audioFramesReceived,
      },
      rtp: {
        video: { packetsReceived: this.videoRtp.packetsReceived, packetsLost: this.videoRtp.packetsLost, octetsReceived: this.videoRtp.octetsReceived },
        audio: { packetsReceived: this.audioRtp.packetsReceived, packetsLost: this.audioRtp.packetsLost, octetsReceived: this.audioRtp.octetsReceived },
      },
      sync: {
        lastCaptureMs: this.lastCaptureMs,
        // positive: audio is newer than video (camera clock); useful to eyeball A/V alignment
        audioMinusVideoMs: this.lastAudioCaptureMs !== null && this.lastVideoCaptureMs !== null ? this.lastAudioCaptureMs - this.lastVideoCaptureMs : null,
        pending: this.syncFromMs !== null,
        oldVideoFrames: this.oldVideoFrames, oldAudioFrames: this.oldAudioFrames,
      },
      unknownPayloadType: this.unknownPayloadType,
      lastFrameAt: this.latestFrameAt && this.latestFrameAt.toISOString(),
    };
  }
}

module.exports = { Camera };
