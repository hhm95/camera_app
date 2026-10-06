'use strict';
// RTP (RFC 3550) + H.264 payload format (RFC 6184): single NAL unit, STAP-A and FU-A packets.

const crypto = require('node:crypto');

const RTP_HEADER = 12;
const CLOCK_RATE = 90000;
const PT_H264 = 96;
const PT_OPUS = 97; // dynamic payload type (no signaling channel, agreed by convention like PT_H264)
// RFC 7587: Opus's RTP clock rate is always nominally 48 kHz regardless of the actual encoded
// sample rate. 960 = 20ms of it, matching the encoder's fixed 20ms frame duration.
const OPUS_CLOCK_RATE = 48000;
const OPUS_SAMPLES_PER_FRAME = 960;
// "Old" (replayed) media travels on the same channel under its own payload types, so the host can
// tell backfilled data from live data without any extra signaling.
const PT_H264_OLD = 98;
const PT_OPUS_OLD = 99;
// First byte of an application control message (host -> camera sync request, camera -> host reply).
// RTP packets start with 0x80..0xBF and the keepalive with 0x01, so this cannot collide.
const MSG_CONTROL = 0x02;
// Every media unit carries the camera's wall-clock capture time (UTC ms) in an RFC 3550 header
// extension on its first packet. The RTP timestamps of video (90 kHz) and audio (48 kHz) are
// unrelated counters; this shared clock is what lets the host match a picture with its sound.
const EXT_PROFILE = 0x4341; // "CA"
const EXT_SIZE = 4 + 8; // extension header + one uint64
// One DTLS record carries one RTP packet. Stay well below a 1200 byte datagram, leaving room
// for the DTLS 1.3 record header/tag and UDP/IP headers.
const DEFAULT_MAX_PACKET = 1100;

const NAL_STAP_A = 24;
const NAL_FU_A = 28;

class RtpPacketizer {
  constructor({ ssrc, payloadType = PT_H264, maxPacketSize = DEFAULT_MAX_PACKET, initialSeq } = {}) {
    this.ssrc = ssrc ?? crypto.randomBytes(4).readUInt32BE(0);
    this.payloadType = payloadType;
    this.maxPayload = maxPacketSize - RTP_HEADER - EXT_SIZE; // worst case: extension on every packet
    this.seq = initialSeq ?? crypto.randomBytes(2).readUInt16BE(0);
    this.packetsSent = 0;
    this.octetsSent = 0;
  }

  /**
   * @param {Buffer[]} nals  NAL units of one access unit (no start codes)
   * @param {number} timestamp  90 kHz RTP timestamp (uint32)
   * @param {number} [captureMs]  camera wall-clock capture time, carried in the first packet
   * @returns {Buffer[]} RTP packets; the marker bit is set on the last one
   */
  packetizeAccessUnit(nals, timestamp, captureMs) {
    const payloads = [];
    let group = [];
    let groupSize = 1; // STAP-A header byte
    const flushGroup = () => {
      if (group.length === 1) payloads.push(group[0]);
      else if (group.length > 1) payloads.push(buildStapA(group));
      group = [];
      groupSize = 1;
    };

    for (const nal of nals) {
      if (nal.length + 2 + 1 > this.maxPayload) {
        // Too big to aggregate (and possibly too big for a single packet).
        flushGroup();
        if (nal.length <= this.maxPayload) payloads.push(nal);
        else payloads.push(...fragmentFuA(nal, this.maxPayload));
        continue;
      }
      if (groupSize + 2 + nal.length > this.maxPayload) flushGroup();
      group.push(nal);
      groupSize += 2 + nal.length;
    }
    flushGroup();

    return payloads.map((payload, i) => this._packet(payload, timestamp, i === payloads.length - 1, i === 0 ? captureMs : undefined));
  }

  /**
   * Packetize one already-complete media frame that never needs fragmentation (e.g. one Opus
   * audio frame). Unlike packetizeAccessUnit this has no codec-specific framing at all.
   * @returns {Buffer[]} always exactly one RTP packet
   */
  packetizeFrame(payload, timestamp, captureMs, marker = false) {
    if (payload.length > this.maxPayload) {
      throw new Error(`packetizeFrame: payload of ${payload.length} bytes exceeds maxPayload ${this.maxPayload}`);
    }
    return [this._packet(payload, timestamp, marker, captureMs)];
  }

  _packet(payload, timestamp, marker, captureMs) {
    const ext = captureMs !== undefined && captureMs !== null;
    const hdr = RTP_HEADER + (ext ? EXT_SIZE : 0);
    const pkt = Buffer.allocUnsafe(hdr + payload.length);
    pkt[0] = ext ? 0x90 : 0x80; // V=2, P=0, X=ext, CC=0
    pkt[1] = (marker ? 0x80 : 0) | (this.payloadType & 0x7f);
    pkt.writeUInt16BE(this.seq, 2);
    pkt.writeUInt32BE(timestamp >>> 0, 4);
    pkt.writeUInt32BE(this.ssrc, 8);
    if (ext) {
      pkt.writeUInt16BE(EXT_PROFILE, RTP_HEADER);
      pkt.writeUInt16BE(2, RTP_HEADER + 2); // length in 32-bit words
      pkt.writeBigUInt64BE(BigInt(Math.round(captureMs)), RTP_HEADER + 4);
    }
    payload.copy(pkt, hdr);
    this.seq = (this.seq + 1) & 0xffff;
    this.packetsSent++;
    this.octetsSent += payload.length;
    return pkt;
  }
}

function buildStapA(nals) {
  const parts = [];
  let maxNri = 0;
  for (const nal of nals) maxNri = Math.max(maxNri, nal[0] & 0x60);
  parts.push(Buffer.from([maxNri | NAL_STAP_A]));
  for (const nal of nals) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(nal.length);
    parts.push(len, nal);
  }
  return Buffer.concat(parts);
}

function fragmentFuA(nal, maxPayload) {
  const header = nal[0];
  const nri = header & 0x60;
  const type = header & 0x1f;
  const chunk = maxPayload - 2;
  const out = [];
  for (let off = 1; off < nal.length; off += chunk) {
    const end = Math.min(off + chunk, nal.length);
    const start = off === 1;
    const last = end === nal.length;
    const fu = Buffer.allocUnsafe(2 + end - off);
    fu[0] = nri | NAL_FU_A;
    fu[1] = (start ? 0x80 : 0) | (last ? 0x40 : 0) | type;
    nal.copy(fu, 2, off, end);
    out.push(fu);
  }
  return out;
}

/** Parse an RTP packet. Returns null when it is not a valid RTP v2 packet. */
function parseRtp(buf) {
  if (buf.length < RTP_HEADER || buf[0] >> 6 !== 2) return null;
  const padding = (buf[0] & 0x20) !== 0;
  const extension = (buf[0] & 0x10) !== 0;
  const csrcCount = buf[0] & 0x0f;
  let offset = RTP_HEADER + csrcCount * 4;
  let captureMs = null;
  if (extension) {
    if (buf.length < offset + 4) return null;
    const words = buf.readUInt16BE(offset + 2);
    if (buf.readUInt16BE(offset) === EXT_PROFILE && words === 2 && buf.length >= offset + EXT_SIZE) {
      captureMs = Number(buf.readBigUInt64BE(offset + 4));
    }
    offset += 4 + words * 4;
  }
  let end = buf.length;
  if (padding) end -= buf[buf.length - 1];
  if (offset > end) return null;
  return {
    marker: (buf[1] & 0x80) !== 0,
    payloadType: buf[1] & 0x7f,
    seq: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    captureMs,
    payload: buf.subarray(offset, end),
  };
}

/**
 * RTP/H.264 depacketizer. push() an RTP packet; completed access units come back as
 * { timestamp, captureMs, nals } (the marker bit or a timestamp change ends an access unit).
 * Lost packets are detected from sequence gaps: a fragmented NAL that lost a fragment is
 * dropped instead of being delivered corrupted.
 */
class RtpDepacketizer {
  constructor() {
    this.expectedSeq = null;
    this.ssrc = null;
    this.packetsReceived = 0;
    this.packetsLost = 0;
    this.octetsReceived = 0;
    this._au = null; // { timestamp, nals }
    this._fu = null; // Buffer[] fragments of the NAL being reassembled
    this._fuBroken = false;
  }

  /** @returns {{timestamp:number, captureMs:number|null, nals:Buffer[]}[]} */
  push(packet) {
    const rtp = parseRtp(packet);
    if (!rtp) return [];
    const done = [];

    if (this.ssrc !== null && rtp.ssrc !== this.ssrc) {
      // Stream restarted with a new SSRC: forget in-flight state.
      this.expectedSeq = null;
      this._fu = null;
      this._au = null;
    }
    this.ssrc = rtp.ssrc;

    let gap = false;
    if (this.expectedSeq !== null) {
      const delta = (rtp.seq - this.expectedSeq) & 0xffff;
      if (delta > 0x8000) return []; // duplicate / late packet
      if (delta > 0) {
        this.packetsLost += delta;
        gap = true;
        if (this._fu) this._fuBroken = true;
      }
    }
    this.expectedSeq = (rtp.seq + 1) & 0xffff;
    this.packetsReceived++;
    this.octetsReceived += rtp.payload.length;

    if (this._au && this._au.timestamp !== rtp.timestamp) {
      done.push(this._finishAu()); // previous AU had no marker (lost): emit what we have
    }
    if (!this._au) this._au = { timestamp: rtp.timestamp, captureMs: null, nals: [], damaged: false };
    if (rtp.captureMs !== null && this._au.captureMs === null) this._au.captureMs = rtp.captureMs;
    if (gap) this._au.damaged = true;

    this._payload(rtp.payload);

    if (rtp.marker) done.push(this._finishAu());
    return done.filter(Boolean);
  }

  _finishAu() {
    const au = this._au;
    this._au = null;
    this._fu = null;
    this._fuBroken = false;
    return au && au.nals.length ? au : null;
  }

  _payload(p) {
    if (!p.length) return;
    const type = p[0] & 0x1f;
    if (type >= 1 && type <= 23) {
      this._au.nals.push(Buffer.from(p));
    } else if (type === NAL_STAP_A) {
      let off = 1;
      while (off + 2 <= p.length) {
        const len = p.readUInt16BE(off);
        off += 2;
        if (off + len > p.length) break;
        this._au.nals.push(Buffer.from(p.subarray(off, off + len)));
        off += len;
      }
    } else if (type === NAL_FU_A && p.length >= 2) {
      const start = (p[1] & 0x80) !== 0;
      const end = (p[1] & 0x40) !== 0;
      if (start) {
        this._fu = [Buffer.from([(p[0] & 0xe0) | (p[1] & 0x1f)])];
        this._fuBroken = false;
      }
      if (!this._fu) return; // fragment of a NAL whose start we never saw
      this._fu.push(p.subarray(2));
      if (end) {
        if (!this._fuBroken) this._au.nals.push(Buffer.concat(this._fu));
        else this._au.damaged = true;
        this._fu = null;
        this._fuBroken = false;
      }
    }
    // other types (STAP-B, MTAP, FU-B) are not used by this system
  }
}

/**
 * Depacketizer for media where one RTP packet always carries exactly one complete, independently
 * decodable frame (e.g. one Opus audio frame) - no NAL/STAP-A/FU-A reassembly needed. push() an
 * RTP packet; returns the frame as [{ timestamp, captureMs, payload }] (empty array if the packet was invalid
 * or a duplicate/late arrival).
 */
class RtpFrameDepacketizer {
  constructor() {
    this.expectedSeq = null;
    this.ssrc = null;
    this.packetsReceived = 0;
    this.packetsLost = 0;
    this.octetsReceived = 0;
  }

  push(packet) {
    const rtp = parseRtp(packet);
    if (!rtp) return [];

    if (this.ssrc !== null && rtp.ssrc !== this.ssrc) {
      this.expectedSeq = null; // stream restarted with a new SSRC
    }
    this.ssrc = rtp.ssrc;

    if (this.expectedSeq !== null) {
      const delta = (rtp.seq - this.expectedSeq) & 0xffff;
      if (delta > 0x8000) return []; // duplicate / late packet
      if (delta > 0) this.packetsLost += delta;
    }
    this.expectedSeq = (rtp.seq + 1) & 0xffff;
    this.packetsReceived++;
    this.octetsReceived += rtp.payload.length;

    return [{ timestamp: rtp.timestamp, captureMs: rtp.captureMs, payload: Buffer.from(rtp.payload) }];
  }
}

/** Control messages: MSG_CONTROL byte followed by UTF-8 JSON. */
function encodeControl(obj) {
  return Buffer.concat([Buffer.from([MSG_CONTROL]), Buffer.from(JSON.stringify(obj), 'utf8')]);
}

/** @returns {object|null} null when the datagram is not a valid control message */
function decodeControl(buf) {
  if (buf.length < 2 || buf[0] !== MSG_CONTROL) return null;
  try { return JSON.parse(buf.toString('utf8', 1)); } catch { return null; }
}

module.exports = {
  RTP_HEADER, CLOCK_RATE, PT_H264, PT_OPUS, PT_H264_OLD, PT_OPUS_OLD, MSG_CONTROL, OPUS_CLOCK_RATE, OPUS_SAMPLES_PER_FRAME, DEFAULT_MAX_PACKET,
  encodeControl, decodeControl,
  RtpPacketizer, RtpDepacketizer, RtpFrameDepacketizer, parseRtp,
};
