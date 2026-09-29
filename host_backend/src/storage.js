'use strict';
// Local filesystem storage:
//   <dataDir>/YYYY/MM/DD/<cameraId>/{video,frames,audio,metadata}
// video/     HHMMSS.h264      raw Annex-B segments (each starts on an IDR, so each is decodable)
// frames/    HHMMSS_mmm.jpg   decoded snapshots, one every frameIntervalMs
// audio/     HHMMSS.opus      Ogg/Opus segments, each its own independently-decodable Ogg stream
// metadata/  events.jsonl     connection / DTLS / segment events

const fs = require('node:fs');
const path = require('node:path');
const { OggOpusWriter } = require('camera-shared');

const pad = (n, w = 2) => String(n).padStart(w, '0');
const dateParts = (d) => ({ y: String(d.getFullYear()), m: pad(d.getMonth() + 1), d: pad(d.getDate()) });
const timeStamp = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function dayDir(dataDir, cameraId, date) {
  const p = dateParts(date);
  return path.join(dataDir, p.y, p.m, p.d, cameraId);
}

class CameraStorage {
  constructor({ dataDir, cameraId, segmentMs, frameIntervalMs, audioSegmentMs, log }) {
    Object.assign(this, { dataDir, cameraId, segmentMs, frameIntervalMs, log });
    this.audioSegmentMs = audioSegmentMs ?? segmentMs;
    this._video = null; // { stream, openedAt, path, bytes }
    this._audio = null; // { stream, openedAt, path, bytes, writer }
    this._lastFrameAt = 0;
  }

  _dirs(date) {
    const base = dayDir(this.dataDir, this.cameraId, date);
    const dirs = {
      base,
      video: path.join(base, 'video'),
      frames: path.join(base, 'frames'),
      audio: path.join(base, 'audio'),
      metadata: path.join(base, 'metadata'),
    };
    for (const d of [dirs.video, dirs.frames, dirs.audio, dirs.metadata]) fs.mkdirSync(d, { recursive: true });
    return dirs;
  }

  /** Append one Annex-B access unit to the current segment (segments always begin on an IDR). */
  writeAccessUnit(annexB, isIdr, now = new Date()) {
    const v = this._video;
    if (v && isIdr && (now - v.openedAt >= this.segmentMs || dateParts(now).d !== dateParts(v.openedAt).d)) {
      this._closeVideo();
    }
    if (!this._video) {
      if (!isIdr) return;
      this._openVideo(now);
    }
    this._video.stream.write(annexB);
    this._video.bytes += annexB.length;
  }

  _openVideo(now) {
    const dirs = this._dirs(now);
    let file = path.join(dirs.video, `${timeStamp(now)}.h264`);
    for (let i = 1; fs.existsSync(file); i++) file = path.join(dirs.video, `${timeStamp(now)}_${i}.h264`);
    const stream = fs.createWriteStream(file);
    stream.on('error', (err) => this.log('error', `video write failed: ${err.message}`));
    this._video = { stream, openedAt: now, path: file, bytes: 0 };
    this.event('segment_start', { file: path.basename(file) }, now);
  }

  _closeVideo() {
    const v = this._video;
    if (!v) return;
    this._video = null;
    v.stream.end();
    this.event('segment_end', { file: path.basename(v.path), bytes: v.bytes });
  }

  /** Append one Opus audio frame to the current segment. Every frame is independently decodable. */
  writeAudioFrame(payload, now = new Date()) {
    const a = this._audio;
    if (a && (now - a.openedAt >= this.audioSegmentMs || dateParts(now).d !== dateParts(a.openedAt).d)) {
      this._closeAudio();
    }
    if (!this._audio) this._openAudio(now);
    this._audio.stream.write(this._audio.writer.frame(payload));
    this._audio.bytes += payload.length;
  }

  _openAudio(now) {
    const dirs = this._dirs(now);
    let file = path.join(dirs.audio, `${timeStamp(now)}.opus`);
    for (let i = 1; fs.existsSync(file); i++) file = path.join(dirs.audio, `${timeStamp(now)}_${i}.opus`);
    const stream = fs.createWriteStream(file);
    stream.on('error', (err) => this.log('error', `audio write failed: ${err.message}`));
    const writer = new OggOpusWriter();
    stream.write(writer.header());
    this._audio = { stream, writer, openedAt: now, path: file, bytes: 0 };
    this.event('audio_segment_start', { file: path.basename(file) }, now);
  }

  _closeAudio() {
    const a = this._audio;
    if (!a) return;
    this._audio = null;
    a.stream.end(a.writer.close());
    this.event('audio_segment_end', { file: path.basename(a.path), bytes: a.bytes });
  }

  /** Rate-limited JPEG snapshot. */
  maybeSaveFrame(jpeg, now = new Date()) {
    if (now - this._lastFrameAt < this.frameIntervalMs) return;
    this._lastFrameAt = now.getTime();
    const dirs = this._dirs(now);
    const file = path.join(dirs.frames, `${timeStamp(now)}_${pad(now.getMilliseconds(), 3)}.jpg`);
    fs.writeFile(file, jpeg, (err) => { if (err) this.log('error', `frame write failed: ${err.message}`); });
  }

  event(type, data = {}, now = new Date()) {
    const line = JSON.stringify({ time: now.toISOString(), camera: this.cameraId, type, ...data }) + '\n';
    try {
      fs.appendFileSync(path.join(this._dirs(now).metadata, 'events.jsonl'), line);
    } catch (err) {
      this.log('error', `metadata write failed: ${err.message}`);
    }
  }

  /** Stop writing the current segment (disconnect); a new one starts at the next IDR. */
  endSegment() { this._closeVideo(); this._closeAudio(); }

  close() { this._closeVideo(); this._closeAudio(); }
}

// ---- read side (used by the REST API) -------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_NAME = /^[\w.-]+$/;

function listDir(dir, filter) {
  try { return fs.readdirSync(dir).filter(filter).sort(); } catch { return []; }
}

/** Days that have data for a camera: [{ date, videoFiles, frames }]. */
function listDays(dataDir, cameraId) {
  const days = [];
  for (const y of listDir(dataDir, (n) => /^\d{4}$/.test(n))) {
    for (const m of listDir(path.join(dataDir, y), (n) => /^\d{2}$/.test(n))) {
      for (const d of listDir(path.join(dataDir, y, m), (n) => /^\d{2}$/.test(n))) {
        const base = path.join(dataDir, y, m, d, cameraId);
        if (!fs.existsSync(base)) continue;
        days.push({
          date: `${y}-${m}-${d}`,
          videoFiles: listDir(path.join(base, 'video'), (n) => n.endsWith('.h264')).length,
          frames: listDir(path.join(base, 'frames'), (n) => n.endsWith('.jpg')).length,
          audioFiles: listDir(path.join(base, 'audio'), (n) => n.endsWith('.opus')).length,
        });
      }
    }
  }
  return days;
}

/** Contents of one day for a camera. */
function readDay(dataDir, cameraId, date) {
  if (!DATE_RE.test(date)) return null;
  const [y, m, d] = date.split('-');
  const base = path.join(dataDir, y, m, d, cameraId);
  if (!fs.existsSync(base)) return null;
  const stat = (sub, name) => {
    const st = fs.statSync(path.join(base, sub, name));
    return { name, bytes: st.size, modified: st.mtime.toISOString() };
  };
  const events = [];
  try {
    const text = fs.readFileSync(path.join(base, 'metadata', 'events.jsonl'), 'utf8');
    for (const line of text.split('\n')) if (line) events.push(JSON.parse(line));
  } catch { /* no metadata yet */ }
  return {
    date,
    video: listDir(path.join(base, 'video'), (n) => n.endsWith('.h264')).map((n) => stat('video', n)),
    frames: listDir(path.join(base, 'frames'), (n) => n.endsWith('.jpg')).map((n) => stat('frames', n)),
    audio: listDir(path.join(base, 'audio'), (n) => n.endsWith('.opus')).map((n) => stat('audio', n)),
    events,
  };
}

/** Resolve a stored file for download, rejecting anything but plain file names. */
function resolveFile(dataDir, cameraId, date, kind, name) {
  if (!DATE_RE.test(date) || !['video', 'frames', 'audio', 'metadata'].includes(kind) || !SAFE_NAME.test(name)) return null;
  const [y, m, d] = date.split('-');
  const file = path.join(dataDir, y, m, d, cameraId, kind, name);
  return fs.existsSync(file) ? file : null;
}

module.exports = { CameraStorage, listDays, readDay, resolveFile };
