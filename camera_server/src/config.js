'use strict';
const path = require('node:path');

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const root = path.join(__dirname, '..', '..');

module.exports = {
  cameraId: process.env.CAMERA_ID || 'camera_001',
  host: process.env.CAMERA_BIND || '0.0.0.0',
  port: num(process.env.CAMERA_PORT, 5684),
  certFile: process.env.CAMERA_CERT || path.join(root, 'certs', 'server-cert.pem'),
  keyFile: process.env.CAMERA_KEY || path.join(root, 'certs', 'server-key.pem'),
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  video: {
    width: num(process.env.CAMERA_WIDTH, 640),
    height: num(process.env.CAMERA_HEIGHT, 360),
    fps: num(process.env.CAMERA_FPS, 15),
    bitrateKbps: num(process.env.CAMERA_BITRATE_KBPS, 800),
    gop: num(process.env.CAMERA_GOP, 30),
  },
  audio: {
    sourceFile: process.env.CAMERA_AUDIO_FILE || path.join(root, 'camera_server', 'src', 'audio_demo', 'Một Con Vịt.mp3'),
    bitrateKbps: num(process.env.CAMERA_AUDIO_BITRATE_KBPS, 32),
    frameMs: num(process.env.CAMERA_AUDIO_FRAME_MS, 20),
  },
  replay: {
    clipSeconds: num(process.env.CAMERA_REPLAY_CLIP_SECONDS, 10), // fake "recorded offline" clip, looped to fill the gap
    maxGapMs: num(process.env.CAMERA_REPLAY_MAX_GAP_SECONDS, 300) * 1000, // never replay more than this
    speed: num(process.env.CAMERA_REPLAY_SPEED, 1), // replay pacing relative to real time (1 = normal speed)
  },
  maxClients: num(process.env.CAMERA_MAX_CLIENTS, 4),
  handshakeTimeoutMs: 10_000,
  idleTimeoutMs: 15_000, // host sends keepalives; drop the session when it goes silent
};
