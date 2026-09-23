'use strict';
// Simulated camera sensor: ffmpeg renders a test pattern with a live clock and encodes it with
// libx264. The raw Annex-B stream is split into NAL units and grouped into access units here.

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { AnnexBParser, AccessUnitBuilder, NAL, nalType } = require('camera-shared');

class PatternEncoder extends EventEmitter {
  constructor({ ffmpeg, cameraId, width, height, fps, bitrateKbps, gop }) {
    super();
    this.opts = { ffmpeg, cameraId, width, height, fps, bitrateKbps, gop };
    this.proc = null;
    this.frameNo = 0;
  }

  get running() { return this.proc !== null; }

  start() {
    if (this.proc) return;
    const { ffmpeg, cameraId, width, height, fps, bitrateKbps, gop } = this.opts;
    // drawtext: camera id + wall clock, so the picture visibly proves the stream is live.
    const font = process.platform === 'win32' ? 'C\\:/Windows/Fonts/consola.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
    const label = `drawtext=fontfile='${font}':text='${cameraId}  %{localtime\\:%Y-%m-%d %H\\\\\\:%M\\\\\\:%S}':x=12:y=h-th-12:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-re', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
      '-vf', label,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
      '-b:v', `${bitrateKbps}k`, '-maxrate', `${bitrateKbps}k`, '-bufsize', `${bitrateKbps * 2}k`,
      // one slice per picture (a VCL NAL == a picture; -tune zerolatency would otherwise turn
      // on sliced-threads and emit one slice per thread), SPS/PPS repeated before every IDR
      '-x264-params', `sliced-threads=0:threads=1:bframes=0:slices=1:repeat-headers=1:aud=0:keyint=${gop}:min-keyint=${gop}:scenecut=0`,
      '-f', 'h264', 'pipe:1',
    ];
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.frameNo = 0;

    const parser = new AnnexBParser();
    const builder = new AccessUnitBuilder();
    const ticksPerFrame = Math.round(90000 / fps);
    proc.stdout.on('data', (chunk) => {
      for (const nal of parser.push(chunk)) {
        const au = builder.push(nal);
        if (!au) continue;
        const idr = au.some((n) => nalType(n) === NAL.IDR);
        const timestamp = (this.frameNo++ * ticksPerFrame) >>> 0;
        this.emit('au', { nals: au, idr, timestamp, frameNo: this.frameNo });
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

module.exports = { PatternEncoder };
