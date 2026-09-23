'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { RtpPacketizer, RtpDepacketizer, parseRtp, AnnexBParser, toAnnexB, AccessUnitBuilder } = require('..');

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

test('AccessUnitBuilder groups parameter sets with the following slice', () => {
  const b = new AccessUnitBuilder();
  assert.equal(b.push(nal(9, 2)), null);
  assert.equal(b.push(nal(7, 10)), null);
  assert.equal(b.push(nal(8, 4)), null);
  const au = b.push(nal(5, 100));
  assert.equal(au.length, 3);
  assert.equal(b.push(nal(1, 100)).length, 1);
});
