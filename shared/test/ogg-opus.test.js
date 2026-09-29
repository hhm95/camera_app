'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { OggPageParser, OggOpusWriter } = require('..');

test('OggOpusWriter output round-trips through OggPageParser byte-exact', () => {
  const writer = new OggOpusWriter();
  const frames = Array.from({ length: 5 }, () => crypto.randomBytes(1 + Math.floor(Math.random() * 200)));
  const stream = Buffer.concat([writer.header(), ...frames.map((f) => writer.frame(f)), writer.close()]);

  const parser = new OggPageParser();
  const packets = [];
  // Feed it in small, arbitrary chunks to exercise cross-chunk buffering, same as ffmpeg stdout.
  for (let i = 0; i < stream.length; i += 13) packets.push(...parser.push(stream.subarray(i, i + 13)));

  assert.equal(packets.length, 2 + frames.length + 1); // OpusHead, OpusTags, N frames, EOS
  assert.equal(packets[0].toString('ascii', 0, 8), 'OpusHead');
  assert.equal(packets[1].toString('ascii', 0, 8), 'OpusTags');
  for (let i = 0; i < frames.length; i++) assert.deepEqual(packets[2 + i], frames[i]);
  assert.equal(packets.at(-1).length, 0); // EOS page carries an empty packet
});

test('OggPageParser handles a packet larger than 255 bytes (multi-segment)', () => {
  const writer = new OggOpusWriter();
  const bigFrame = crypto.randomBytes(600); // spans 3 lacing segments (255+255+90)
  const stream = Buffer.concat([writer.header(), writer.frame(bigFrame)]);

  const parser = new OggPageParser();
  const packets = parser.push(stream);
  assert.equal(packets.length, 3);
  assert.deepEqual(packets[2], bigFrame);
});

test('each OggOpusWriter instance uses its own serial number', () => {
  const a = new OggOpusWriter();
  const b = new OggOpusWriter();
  const serial = (buf) => buf.readUInt32LE(14);
  assert.notEqual(serial(a.header()), serial(b.header()));
});
