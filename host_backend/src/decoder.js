'use strict';
// H.264 decoder: pipes Annex-B access units into ffmpeg and yields one JPEG per decoded picture.

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

class JpegDecoder extends EventEmitter {
  constructor({ ffmpeg, log }) {
    super();
    this.ffmpeg = ffmpeg;
    this.log = log;
    this.proc = null;
    this._buf = Buffer.alloc(0);
    this._active = false;
    this.framesDecoded = 0;
  }

  start() {
    this._active = true;
    this._spawn();
  }

  stop() {
    this._active = false;
    this._kill();
  }

  /** Discard decoder state (new stream / reconnect). */
  reset() {
    this._kill();
    if (this._active) this._spawn();
  }

  write(annexB) {
    const p = this.proc;
    if (!p || !p.stdin.writable || p.stdin.writableNeedDrain) return; // drop rather than queue unboundedly
    p.stdin.write(annexB);
  }

  _spawn() {
    if (this.proc) return;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      // Low latency without frame loss: frame threading adds (threads - 1) frames of delay, so
      // decode single-threaded. Do NOT add "-fflags nobuffer": it makes ffmpeg drop frames of a
      // raw H.264 pipe (only 40 of 100 pictures were decoded).
      '-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
      '-threads', '1', '-f', 'h264', '-i', 'pipe:0',
      '-an', '-threads', '1', '-c:v', 'mjpeg', '-q:v', '5', '-flush_packets', '1', '-f', 'image2pipe', 'pipe:1',
    ];
    const proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this._buf = Buffer.alloc(0);
    proc.stdin.on('error', () => { /* ffmpeg exited; handled by 'exit' */ });
    proc.stdout.on('data', (chunk) => this._onData(chunk));
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-1000); });
    proc.on('error', (err) => {
      if (this.proc === proc) this.proc = null;
      this.log('error', `cannot start ffmpeg decoder (${this.ffmpeg}): ${err.message}`);
    });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      if (proc.killedByUs) return;
      if (this._active) {
        this.log('warn', `decoder exited (code ${code}) ${stderr.trim()}; restarting`);
        setTimeout(() => { if (this._active) this._spawn(); }, 500);
      }
    });
  }

  _kill() {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    p.killedByUs = true;
    p.stdout.removeAllListeners('data');
    try { p.stdin.destroy(); } catch { /* ignore */ }
    p.kill();
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      if (this._buf.length < 4) return;
      if (this._buf[0] !== 0xff || this._buf[1] !== 0xd8) {
        const soi = this._buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (soi < 0) { this._buf = Buffer.alloc(0); return; }
        this._buf = this._buf.subarray(soi);
      }
      const eoi = this._buf.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (eoi < 0) return;
      const jpeg = Buffer.from(this._buf.subarray(0, eoi + 2));
      this._buf = this._buf.subarray(eoi + 2);
      this.framesDecoded++;
      this.emit('frame', jpeg);
    }
  }
}

/** Width/height from the first SOFn marker of a JPEG. */
function jpegSize(jpeg) {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) { i++; continue; }
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return null;
}

module.exports = { JpegDecoder, jpegSize };
