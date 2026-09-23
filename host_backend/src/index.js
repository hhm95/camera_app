'use strict';
// host_backend: connects to every camera over DTLS 1.3 (wolfSSL), records the RTP/H.264 stream
// and exposes it to the dashboard through a REST API.

const fs = require('node:fs');
const config = require('./config');
const { Camera } = require('./camera');
const { createApi } = require('./api');
const { wolfsslVersion } = require('wolfssl-dtls');

const log = (level, msg) =>
  console[level === 'error' ? 'error' : 'log'](`${new Date().toISOString()} [host] ${level}: ${msg}`);

function main() {
  log('info', `wolfSSL ${wolfsslVersion} initialised`);
  const caPem = fs.readFileSync(config.caFile);
  fs.mkdirSync(config.dataDir, { recursive: true });

  const cameras = new Map();
  for (const cfg of config.cameras) {
    cameras.set(cfg.id, new Camera(cfg, {
      caPem, dataDir: config.dataDir, ffmpeg: config.ffmpeg, storage: config.storage, transport: config.transport, log,
    }));
  }

  const app = createApi({ cameras, dataDir: config.dataDir, dashboardDir: config.dashboardDir });
  const server = app.listen(config.httpPort, config.httpHost, () => {
    log('info', `REST API + dashboard on http://localhost:${config.httpPort}/ (${cameras.size} camera(s))`);
    for (const cam of cameras.values()) cam.start();
  });
  server.on('error', (err) => { log('error', err.message); process.exit(1); });

  const shutdown = () => {
    log('info', 'shutting down');
    for (const cam of cameras.values()) cam.stop();
    server.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
