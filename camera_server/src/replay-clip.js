'use strict';
// Fake "recorded while offline" footage for the sync demo. Built once at startup: ffmpeg renders a
// short clip (test pattern labelled REPLAY + the demo song), which is parsed into access units /
// Opus frames kept in RAM. The camera replays it, re-stamped to the time window the host asks for.

const { spawn } = require('node:child_process');
const { AnnexBParser, AccessUnitBuilder, OggPageParser, NAL, nalType } = require('camera-shared');

const HEADER_PACKETS = 2; // OpusHead, OpusTags

function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.on('error', (err) => reject(new Error(`cannot start ffmpeg (${ffmpeg}): ${err.message}`)));
    proc.on('exit', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
  });
}

/**
 * @returns {Promise<{durationMs:number, ticksPerFrame:number, video:{nals:Buffer[],idr:boolean,offsetMs:number,timestamp:number}[],
 *                    audio:{payload:Buffer,offsetMs:number,timestamp:number}[]}>}
 */
async function buildReplayClip({ ffmpeg, cameraId, video, audio, seconds }) {
  const { width, height, fps, bitrateKbps, gop } = video;
  const font = process.platform === 'win32' ? 'C\\:/Windows/Fonts/consola.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
  const label = `drawtext=fontfile='${font}':text='${cameraId}  REPLAY (recorded while offline)':x=12:y=h-th-12:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=6`;
  const [h264, ogg] = await Promise.all([
    runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
      '-vf', `hue=h=120,${label}`, // hue shift so replayed footage is visibly different from live
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
      '-b:v', `${bitrateKbps}k`, '-maxrate', `${bitrateKbps}k`, '-bufsize', `${bitrateKbps * 2}k`,
      '-x264-params', `sliced-threads=0:threads=1:bframes=0:slices=1:repeat-headers=1:aud=0:keyint=${gop}:min-keyint=${gop}:scenecut=0`,
      '-f', 'h264', 'pipe:1',
    ]),
    runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-t', String(seconds), '-i', audio.sourceFile, '-map', '0:a:0', '-vn',
      '-c:a', 'libopus', '-ar', '48000', '-ac', '1', '-b:a', `${audio.bitrateKbps}k`,
      '-frame_duration', String(audio.frameMs),
      '-f', 'ogg', 'pipe:1',
    ]),
  ]);

  const ticksPerFrame = Math.round(90000 / fps);
  const videoUnits = [];
  const parser = new AnnexBParser();
  const builder = new AccessUnitBuilder();
  for (const nal of [...parser.push(h264), ...parser.flush()]) {
    const au = builder.push(nal);
    if (au) videoUnits.push(au);
  }
  const videoFrames = videoUnits.map((nals, i) => ({
    nals, idr: nals.some((n) => nalType(n) === NAL.IDR), offsetMs: Math.round((i * 1000) / fps), timestamp: (i * ticksPerFrame) >>> 0,
  }));
  // The replay must start on an IDR so the host can decode it from the first frame.
  while (videoFrames.length && !videoFrames[0].idr) videoFrames.shift();

  const audioFrames = [];
  const oggParser = new OggPageParser();
  let idx = 0;
  for (const packet of oggParser.push(ogg)) {
    if (idx++ < HEADER_PACKETS) continue;
    const n = audioFrames.length;
    audioFrames.push({ payload: packet, offsetMs: n * audio.frameMs, timestamp: (n * 960) >>> 0 });
  }

  if (!videoFrames.length || !audioFrames.length) throw new Error('replay clip is empty (check ffmpeg / audio file)');
  const durationMs = Math.round(Math.min(videoFrames.length * 1000 / fps, audioFrames.length * audio.frameMs));
  return { durationMs, ticksPerFrame, video: videoFrames, audio: audioFrames };
}

module.exports = { buildReplayClip };
