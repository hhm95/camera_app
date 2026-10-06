'use strict';
// Simulated camera microphone: ffmpeg loops a demo song file forever and encodes it as Opus. Opus
// packets have no self-delimiting length when raw, so ffmpeg can only emit them wrapped in a
// container (Ogg); OggPageParser turns that byte stream back into discrete Opus frames here, the
// same role AnnexBParser plays for the raw H.264 video stream.

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { OggPageParser, OPUS_SAMPLES_PER_FRAME } = require('camera-shared');

const HEADER_PACKETS = 2; // OpusHead, OpusTags - not audio, discarded

class AudioEncoder extends EventEmitter {
  constructor({ ffmpeg, cameraId, sourceFile, bitrateKbps, frameMs }) {
    super();
    this.opts = { ffmpeg, cameraId, sourceFile, bitrateKbps, frameMs };
    this.proc = null;
    this.frameNo = 0;
  }

  get running() { return this.proc !== null; }

  start() {
    if (this.proc) return;
    const { ffmpeg, sourceFile, bitrateKbps, frameMs } = this.opts;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-re', '-stream_loop', '-1', '-i', sourceFile, '-map', '0:a:0', '-vn',
      '-c:a', 'libopus', '-ar', '48000', '-ac', '1', '-b:a', `${bitrateKbps}k`,
      '-frame_duration', String(frameMs),
      '-f', 'ogg', 'pipe:1',
    ];
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.frameNo = 0;

    const parser = new OggPageParser();
    let packetIdx = 0;
    proc.stdout.on('data', (chunk) => {
      for (const packet of parser.push(chunk)) {
        if (packetIdx++ < HEADER_PACKETS) continue; // OpusHead / OpusTags
        const timestamp = (this.frameNo++ * OPUS_SAMPLES_PER_FRAME) >>> 0;
        this.emit('frame', { payload: packet, timestamp, captureMs: Date.now(), frameNo: this.frameNo });
      }
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.on('error', (err) => {
      this.proc = null;
      this.emit('error', new Error(`cannot start ffmpeg (${ffmpeg}): ${err.message}`));
    });
    proc.on('exit', (code, signal) => {
      if (this.proc === proc) this.proc = null;
      this.emit('exit', { code, signal, stderr });
    });
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.stdout.removeAllListeners('data');
    proc.kill();
  }
}

module.exports = { AudioEncoder };
