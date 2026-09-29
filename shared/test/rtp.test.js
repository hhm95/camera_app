'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { RtpPacketizer, RtpDepacketizer, RtpFrameDepacketizer, parseRtp, AnnexBParser, toAnnexB, AccessUnitBuilder, PT_H264, PT_OPUS } = require('..');

const nal = (type, size, nri = 0x60) => {
  const b = crypto.randomBytes(size);
  b[0] = nri | type;
  return b;
};

function roundTrip(nals, opts = {}) {
  const pk = new RtpPacketizer({ ssrc: 1234, ...opts });
  const packets = pk.packetizeAccessUnit(nals, 90000);
  const dp = new RtpDepacketizer();
  const aus = packets.flatMap((p) => dp.push(p));
  return { packets, aus, dp };
}

test('small NALs (SPS/PPS/IDR) are aggregated / sent as-is and reassembled', () => {
  const nals = [nal(7, 20), nal(8, 6), nal(5, 300)];
  const { packets, aus } = roundTrip(nals);
  assert.equal(aus.length, 1);
  assert.deepEqual(aus[0].nals, nals);
  assert.equal(aus[0].timestamp, 90000);
  assert.equal(parseRtp(packets.at(-1)).marker, true);
  assert.equal(parseRtp(packets[0]).marker, packets.length === 1);
});

test('large NAL is split into FU-A and reassembled bit-exact', () => {
  const nals = [nal(7, 20), nal(8, 6), nal(5, 20000)];
  const { packets, aus } = roundTrip(nals);
  assert.ok(packets.length > 15);
  assert.ok(packets.every((p) => p.length <= 1100));
  assert.deepEqual(aus[0].nals, nals);
});

test('sequence numbers wrap around', () => {
  const pk = new RtpPacketizer({ ssrc: 1, initialSeq: 65534 });
  const dp = new RtpDepacketizer();
  const out = [];
  for (let i = 0; i < 4; i++) out.push(...pk.packetizeAccessUnit([nal(1, 100)], i * 6000).flatMap((p) => dp.push(p)));
  assert.equal(out.length, 4);
  assert.equal(dp.packetsLost, 0);
});

test('lost FU-A fragment drops the NAL instead of delivering it corrupted', () => {
  const pk = new RtpPacketizer({ ssrc: 1 });
  const packets = pk.packetizeAccessUnit([nal(5, 5000)], 1000);
  assert.ok(packets.length > 3);
  const dp = new RtpDepacketizer();
  const aus = packets.filter((_, i) => i !== 2).flatMap((p) => dp.push(p));
  assert.equal(dp.packetsLost, 1);
  assert.equal(aus.length, 0); // nothing usable in that AU
  // stream recovers with the next access unit
  const next = pk.packetizeAccessUnit([nal(1, 500)], 4000).flatMap((p) => dp.push(p));
  assert.equal(next.length, 1);
});

test('Annex-B parser handles 3/4 byte start codes across chunk boundaries', () => {
  const nals = [nal(9, 2), nal(7, 30), nal(8, 5), nal(5, 4000)];
  for (const n of nals) { n[1] = 0x55; n[n.length - 1] = 0x77; } // avoid stray zero bytes at edges
  const stream = Buffer.concat([toAnnexB(nals), Buffer.from([0, 0, 1]), nal(1, 50)]);
  const parser = new AnnexBParser();
  const got = [];
  for (let i = 0; i < stream.length; i += 7) got.push(...parser.push(stream.subarray(i, i + 7)));
  got.push(...parser.flush());
  assert.equal(got.length, 5);
  assert.deepEqual(got.slice(0, 4), nals);
});

test('packetizeFrame/RtpFrameDepacketizer round-trips audio frames', () => {
  const pk = new RtpPacketizer({ ssrc: 42, payloadType: PT_OPUS });
  const dp = new RtpFrameDepacketizer();
  const frames = [];
  for (let i = 0; i < 5; i++) {
    const payload = crypto.randomBytes(160);
    const [pkt] = pk.packetizeFrame(payload, i * 160);
    frames.push({ payload, out: dp.push(pkt) });
  }
  for (const f of frames) {
    assert.equal(f.out.length, 1);
    assert.deepEqual(f.out[0].payload, f.payload);
  }
  assert.equal(dp.packetsReceived, 5);
  assert.equal(dp.packetsLost, 0);
});

test('packetizeFrame rejects a payload larger than the max packet size', () => {
  const pk = new RtpPacketizer({ ssrc: 1, maxPacketSize: 100 });
  assert.throws(() => pk.packetizeFrame(Buffer.alloc(200), 0));
});

test('video and audio streams demux cleanly by payload type without cross-contaminating depacketizers', () => {
  const videoPk = new RtpPacketizer({ ssrc: 1000, payloadType: PT_H264 });
  const audioPk = new RtpPacketizer({ ssrc: 2000, payloadType: PT_OPUS });
  const videoNals = [nal(7, 20), nal(8, 6), nal(5, 300)];
  const videoPackets = videoPk.packetizeAccessUnit(videoNals, 90000);
  const audioPayloads = Array.from({ length: 3 }, () => crypto.randomBytes(160));
  const audioPackets = audioPayloads.map((p, i) => audioPk.packetizeFrame(p, i * 160)[0]);

  // Interleave both streams onto one "channel" and demux by payload type, exactly as
  // host_backend/src/camera.js's _onRtp does.
  const interleaved = [];
  for (let i = 0; i < Math.max(videoPackets.length, audioPackets.length); i++) {
    if (videoPackets[i]) interleaved.push(videoPackets[i]);
    if (audioPackets[i]) interleaved.push(audioPackets[i]);
  }

  const videoDp = new RtpDepacketizer();
  const audioDp = new RtpFrameDepacketizer();
  const videoAus = [];
  const audioFrames = [];
  for (const pkt of interleaved) {
    const rtp = parseRtp(pkt);
    if (rtp.payloadType === PT_H264) videoAus.push(...videoDp.push(pkt));
    else if (rtp.payloadType === PT_OPUS) audioFrames.push(...audioDp.push(pkt));
  }

  assert.equal(videoAus.length, 1);
  assert.deepEqual(videoAus[0].nals, videoNals);
  assert.equal(audioFrames.length, 3);
  for (let i = 0; i < 3; i++) assert.deepEqual(audioFrames[i].payload, audioPayloads[i]);
});

test('AccessUnitBuilder groups parameter sets with the following slice', () => {
  const b = new AccessUnitBuilder();
  assert.equal(b.push(nal(9, 2)), null);
  assert.equal(b.push(nal(7, 10)), null);
  assert.equal(b.push(nal(8, 4)), null);
  const au = b.push(nal(5, 100));
  assert.equal(au.length, 3);
  assert.equal(b.push(nal(1, 100)).length, 1);
});
