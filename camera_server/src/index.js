'use strict';
// camera_server: simulated IP camera. UDP -> wolfSSL DTLS 1.3 (X25519 + Ed25519) -> RTP/H.264.

const config = require('./config');
const { DtlsServer } = require('./dtls-server');
const { PatternEncoder } = require('./pattern-encoder');
const { Streamer } = require('./streamer');
const { wolfsslVersion } = require('wolfssl-dtls');

const log = (level, msg) =>
  console[level === 'error' ? 'error' : 'log'](`${new Date().toISOString()} [camera ${config.cameraId}] ${level}: ${msg}`);

async function main() {
  log('info', `wolfSSL ${wolfsslVersion} initialised`);
  const encoder = new PatternEncoder({ ffmpeg: config.ffmpeg, cameraId: config.cameraId, ...config.video });
  encoder.on('error', (err) => log('error', err.message));
  const streamer = new Streamer({ encoder, log });

  const server = new DtlsServer({ ...config, log });
  server.on('error', (err) => { log('error', err.message); process.exit(1); });
  // Media starts only after the handshake completed ('client' is emitted on `established`).
  server.on('client', (channel, key) => streamer.addClient(channel, key));
  server.on('clientClosed', (channel) => streamer.removeClient(channel));

  const addr = await server.listen();
  log('info', `UDP server listening on ${addr.address}:${addr.port} (DTLS 1.3, ${config.video.width}x${config.video.height}@${config.video.fps})`);

  const shutdown = async () => {
    log('info', 'shutting down');
    encoder.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => { log('error', err.stack || err.message); process.exit(1); });
