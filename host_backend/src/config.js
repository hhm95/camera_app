'use strict';
const fs = require('node:fs');
const path = require('node:path');

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const backendRoot = path.join(__dirname, '..');
const projectRoot = path.join(backendRoot, '..');

const camerasFile = process.env.CAMERAS_FILE || path.join(backendRoot, 'cameras.json');

module.exports = {
  httpHost: process.env.HOST_HTTP_BIND || '0.0.0.0',
  httpPort: num(process.env.HOST_HTTP_PORT, 3000),
  dataDir: process.env.HOST_DATA_DIR || path.join(backendRoot, 'data'),
  caFile: process.env.HOST_CA_CERT || path.join(projectRoot, 'certs', 'ca-cert.pem'),
  dashboardDir: process.env.DASHBOARD_DIR || path.join(projectRoot, 'dashboard_view'),
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  cameras: JSON.parse(fs.readFileSync(camerasFile, 'utf8')),
  storage: {
    segmentMs: num(process.env.HOST_SEGMENT_SECONDS, 300) * 1000, // new .h264 file every N seconds
    frameIntervalMs: num(process.env.HOST_FRAME_INTERVAL_SECONDS, 5) * 1000, // JPEG snapshot cadence
    audioSegmentMs: num(process.env.HOST_AUDIO_SEGMENT_SECONDS, num(process.env.HOST_SEGMENT_SECONDS, 300)) * 1000, // new .opus file every N seconds
  },
  transport: {
    handshakeTimeoutMs: 10_000,
    keepaliveMs: 5_000,
    idleTimeoutMs: 10_000, // no packet from the camera for this long => reconnect
    minBackoffMs: 1_000,
    maxBackoffMs: 10_000,
  },
};
