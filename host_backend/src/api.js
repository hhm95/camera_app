'use strict';
// HTTP REST API for the dashboard (the dashboard never talks to the camera directly).

const express = require('express');
const { OggOpusWriter } = require('camera-shared');
const { listDays, readDay, resolveFile } = require('./storage');

const BOUNDARY = 'camframe';

function createApi({ cameras, dataDir, dashboardDir }) {
  const app = express();
  app.disable('x-powered-by');

  // The dashboard is served from this same server, but allow opening it from elsewhere too.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
  });

  const api = express.Router();

  api.get('/health', (req, res) => res.json({ ok: true, cameras: cameras.size }));

  api.get('/cameras', (req, res) => {
    res.json([...cameras.values()].map((c) => {
      const s = c.status();
      return {
        id: s.id, name: s.name, state: s.state, address: s.address,
        resolution: s.video.resolution, fps: s.video.fps, dtls: s.dtls && `${s.dtls.version} ${s.dtls.group} ${s.dtls.signature}`,
        links: {
          status: `/api/cameras/${s.id}/status`,
          live: `/api/cameras/${s.id}/live`,
          liveAudio: `/api/cameras/${s.id}/live/audio`,
          snapshot: `/api/cameras/${s.id}/live/snapshot.jpg`,
          recordings: `/api/cameras/${s.id}/recordings`,
        },
      };
    }));
  });

  api.param('id', (req, res, next, id) => {
    const cam = cameras.get(id);
    if (!cam) return res.status(404).json({ error: `unknown camera "${id}"` });
    req.camera = cam;
    next();
  });

  api.get('/cameras/:id/status', (req, res) => res.json(req.camera.status()));

  // Live view: multipart/x-mixed-replace (MJPEG) works directly in an <img> tag.
  api.get('/cameras/:id/live', (req, res) => {
    const cam = req.camera;
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
    });
    const send = (jpeg) => {
      if (res.writableNeedDrain) return; // slow viewer: skip frames instead of buffering
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write('\r\n');
    };
    if (cam.latestFrame) send(cam.latestFrame);
    cam.on('frame', send);
    req.on('close', () => cam.off('frame', send));
  });

  // Live audio: a continuous Ogg/Opus byte stream, the same trick internet radio stations use for
  // Ogg streams. Each listener gets its own OggOpusWriter (own header pages, own granule position)
  // since Ogg Opus - unlike MP3 - can't be joined mid-stream without a fresh OpusHead/OpusTags.
  api.get('/cameras/:id/live/audio', (req, res) => {
    const cam = req.camera;
    res.writeHead(200, {
      'Content-Type': 'audio/ogg',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
    });
    const writer = new OggOpusWriter();
    res.write(writer.header());
    const send = (payload) => { if (!res.writableNeedDrain) res.write(writer.frame(payload)); };
    cam.on('audioFrame', send);
    req.on('close', () => cam.off('audioFrame', send));
  });

  api.get('/cameras/:id/live/snapshot.jpg', (req, res) => {
    const cam = req.camera;
    if (!cam.latestFrame) return res.status(503).json({ error: 'no frame available yet', state: cam.status().state });
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).send(cam.latestFrame);
  });

  api.get('/cameras/:id/recordings', (req, res) => {
    res.json({ camera: req.camera.id, days: listDays(dataDir, req.camera.id) });
  });

  api.get('/cameras/:id/recordings/:date', (req, res) => {
    const day = readDay(dataDir, req.camera.id, req.params.date);
    if (!day) return res.status(404).json({ error: `no recordings for ${req.params.date} (use YYYY-MM-DD)` });
    const url = (kind, name) => `/api/cameras/${req.camera.id}/recordings/${day.date}/files/${kind}/${name}`;
    res.json({
      camera: req.camera.id,
      ...day,
      video: day.video.map((f) => ({ ...f, url: url('video', f.name) })),
      frames: day.frames.map((f) => ({ ...f, url: url('frames', f.name) })),
      audio: day.audio.map((f) => ({ ...f, url: url('audio', f.name) })),
    });
  });

  const CONTENT_TYPES = { '.jpg': 'image/jpeg', '.opus': 'audio/ogg', '.h264': 'video/h264' };
  api.get('/cameras/:id/recordings/:date/files/:kind/:name', (req, res) => {
    const file = resolveFile(dataDir, req.camera.id, req.params.date, req.params.kind, req.params.name);
    if (!file) return res.status(404).json({ error: 'file not found' });
    const ext = file.slice(file.lastIndexOf('.'));
    res.sendFile(file, { headers: { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' } });
  });

  api.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use('/api', api);
  app.use(express.static(dashboardDir));
  return app;
}

module.exports = { createApi };
