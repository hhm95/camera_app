'use strict';
// camera_server: simulated IP camera. UDP -> wolfSSL DTLS 1.3 (X25519 + Ed25519) -> RTP/H.264.

const config = require('./config');
const { DtlsServer } = require('./dtls-server');
const { PatternEncoder } = require('./pattern-encoder');
const { AudioEncoder } = require('./audio-encoder');
const { Streamer } = require('./streamer');
const { buildReplayClip } = require('./replay-clip');
const { wolfsslVersion } = require('wolfssl-dtls');
const { decodeControl } = require('camera-shared');

const log = (level, msg) =>
  console[level === 'error' ? 'error' : 'log'](`${new Date().toISOString()} [camera ${config.cameraId}] ${level}: ${msg}`);

async function main() {
  log('info', `wolfSSL ${wolfsslVersion} initialised`);
  const videoEncoder = new PatternEncoder({ ffmpeg: config.ffmpeg, cameraId: config.cameraId, ...config.video });
  videoEncoder.on('error', (err) => log('error', err.message));
  const audioEncoder = new AudioEncoder({ ffmpeg: config.ffmpeg, cameraId: config.cameraId, ...config.audio });
  audioEncoder.on('error', (err) => log('error', err.message));
  const streamer = new Streamer({ videoEncoder, audioEncoder, replay: config.replay, log });
  buildReplayClip({ ffmpeg: config.ffmpeg, cameraId: config.cameraId, video: config.video, audio: config.audio, seconds: config.replay.clipSeconds })
    .then((clip) => { streamer.setReplayClip(clip); log('info', `replay clip ready: ${clip.video.length} video / ${clip.audio.length} audio frames, ${clip.durationMs} ms`); })
    .catch((err) => log('error', `replay clip unavailable, sync requests will be empty: ${err.message}`));

  const server = new DtlsServer({ ...config, log });
  server.on('error', (err) => { log('error', err.message); process.exit(1); });
  // Media starts only after the handshake completed ('client' is emitted on `established`).
  server.on('client', (channel, key) => streamer.addClient(channel, key));
  // Application control messages from the host (RTP never flows host -> camera; keepalives are 0x01).
  server.on('clientData', (channel, key, data) => {
    const msg = decodeControl(data);
    if (!msg) return;
    if (msg.type === 'sync') streamer.startReplay(channel, msg);
    else log('warn', `${key}: unknown control message type "${msg.type}"`);
  });
  server.on('clientClosed', (channel) => streamer.removeClient(channel));

  const addr = await server.listen();
  log('info', `UDP server listening on ${addr.address}:${addr.port} (DTLS 1.3, ${config.video.width}x${config.video.height}@${config.video.fps}, audio Opus ${config.audio.bitrateKbps}kbps)`);

  const shutdown = async () => {
    log('info', 'shutting down');
    videoEncoder.stop();
    audioEncoder.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => { log('error', err.stack || err.message); process.exit(1); });
