'use strict';
// Minimal Ogg container support for a single Opus logical stream (RFC 3533 Ogg + RFC 7845 Opus).
// OggPageParser turns ffmpeg's `-f ogg` byte stream into discrete Opus packets (the same role
// AnnexBParser plays for ffmpeg's raw H.264 output). OggOpusWriter does the reverse: wraps raw
// Opus packets received over RTP back into a fresh, independently-decodable Ogg stream, either for
// storage or for a single live HTTP listener.

const crypto = require('node:crypto');

const OGG_PAGE_HEADER = 27;

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = ((r << 1) ^ ((r & 0x80000000) ? 0x04c11db7 : 0)) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
}
const CRC_TABLE = buildCrcTable();

/** Ogg's CRC-32 variant: poly 0x04c11db7, not reflected, no final XOR. */
function oggCrc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/**
 * Incremental Ogg page parser. push() chunks of an Ogg byte stream (as ffmpeg emits with
 * `-f ogg`); returns any packets fully completed by this chunk. A packet may span multiple Ogg
 * pages (indicated by a trailing 255-byte lacing value); partial packets are carried across calls
 * the same way RtpDepacketizer carries partial FU-A reassembly.
 */
class OggPageParser {
  constructor() {
    this._buf = Buffer.alloc(0);
    this._pending = []; // fragments of a packet that continues across pages
  }

  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const packets = [];
    for (;;) {
      if (this._buf.length < OGG_PAGE_HEADER) break;
      if (this._buf.toString('ascii', 0, 4) !== 'OggS') {
        // Lost sync (shouldn't happen against our own ffmpeg's output); drop one byte and retry.
        this._buf = this._buf.subarray(1);
        continue;
      }
      const segCount = this._buf[26];
      const headerLen = OGG_PAGE_HEADER + segCount;
      if (this._buf.length < headerLen) break; // segment table not fully buffered yet
      const segTable = this._buf.subarray(OGG_PAGE_HEADER, headerLen);
      const pageBodyLen = segTable.reduce((a, b) => a + b, 0);
      if (this._buf.length < headerLen + pageBodyLen) break; // page payload not fully buffered yet

      let off = headerLen;
      for (const seg of segTable) {
        this._pending.push(this._buf.subarray(off, off + seg));
        off += seg;
        if (seg < 255) {
          packets.push(Buffer.concat(this._pending));
          this._pending = [];
        }
      }
      this._buf = this._buf.subarray(headerLen + pageBodyLen);
    }
    return packets;
  }
}

/**
 * Builds a fresh, independently-decodable Ogg/Opus stream from raw Opus packets. Each instance is
 * its own logical stream (own serial number), so every live HTTP listener or stored segment gets
 * a self-contained file/byte stream starting with its own OpusHead/OpusTags - Ogg Opus, unlike
 * MP3, cannot be joined mid-stream without those.
 */
class OggOpusWriter {
  constructor({ sampleRate = 48000, channels = 1, samplesPerFrame = 960 } = {}) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.samplesPerFrame = samplesPerFrame;
    this.serial = crypto.randomBytes(4).readUInt32BE(0);
    this.pageSeq = 0;
    this.granule = 0;
  }

  /** BOS OpusHead page + OpusTags page. Call once, before any frame(). */
  header() {
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head[8] = 1; // version
    head[9] = this.channels;
    head.writeUInt16LE(0, 10); // pre-skip (hard-coded 0: no signaling channel to convey ffmpeg's actual value)
    head.writeUInt32LE(this.sampleRate, 12); // informational only, decoders use the packet rate
    head.writeInt16LE(0, 16); // output gain
    head[18] = 0; // channel mapping family 0

    const vendor = Buffer.from('camera_app', 'utf8');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0, 'ascii');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length); // 0 user comments

    return Buffer.concat([
      this._page([head], { granule: 0, bos: true }),
      this._page([tags], { granule: 0 }),
    ]);
  }

  /** One Ogg page wrapping a single Opus audio packet. */
  frame(payload) {
    this.granule += this.samplesPerFrame;
    return this._page([payload], { granule: this.granule });
  }

  /** Final, EOS-flagged page (empty payload) - only needed when cleanly ending a stored segment. */
  close() {
    return this._page([Buffer.alloc(0)], { granule: this.granule, eos: true });
  }

  _page(packets, { granule, bos = false, eos = false }) {
    const segTable = [];
    for (const p of packets) {
      let n = p.length;
      while (n >= 255) { segTable.push(255); n -= 255; }
      segTable.push(n);
    }
    const payload = Buffer.concat(packets);
    const header = Buffer.alloc(OGG_PAGE_HEADER + segTable.length);
    header.write('OggS', 0, 'ascii');
    header[4] = 0; // version
    header[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0);
    header.writeBigUInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(this.serial >>> 0, 14);
    header.writeUInt32LE(this.pageSeq++ >>> 0, 18);
    header.writeUInt32LE(0, 22); // CRC placeholder
    header[26] = segTable.length;
    for (let i = 0; i < segTable.length; i++) header[27 + i] = segTable[i];
    const page = Buffer.concat([header, payload]);
    page.writeUInt32LE(oggCrc32(page), 22);
    return page;
  }
}

module.exports = { OggPageParser, OggOpusWriter, oggCrc32 };
