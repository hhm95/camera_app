'use strict';
// H.264 Annex-B helpers.

const START_CODE = Buffer.from([0, 0, 0, 1]);

const NAL = { SLICE: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9 };

const nalType = (nal) => nal[0] & 0x1f;
const isVcl = (nal) => {
  const t = nalType(nal);
  return t >= 1 && t <= 5;
};

/**
 * Incremental Annex-B parser. push() chunks of the byte stream; complete NAL units (without
 * start codes) are returned as soon as the following start code has been seen. The last NAL of
 * a stream is only returned by flush().
 */
class AnnexBParser {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const nals = [];
    let start = findStartCode(this._buf, 0);
    if (!start) return nals; // no start code yet: keep buffering
    for (;;) {
      const next = findStartCode(this._buf, start.end);
      if (!next) break;
      const nal = trimTrailingZeros(this._buf.subarray(start.end, next.begin));
      if (nal.length) nals.push(Buffer.from(nal));
      start = next;
    }
    this._buf = Buffer.from(this._buf.subarray(start.begin)); // keep from the last start code
    return nals;
  }

  flush() {
    const out = [];
    const start = findStartCode(this._buf, 0);
    if (start) {
      const nal = trimTrailingZeros(this._buf.subarray(start.end));
      if (nal.length) out.push(Buffer.from(nal));
    }
    this._buf = Buffer.alloc(0);
    return out;
  }
}

/** Find the next 00 00 01 (optionally preceded by another 00) at or after `from`. */
function findStartCode(buf, from) {
  const idx = buf.indexOf(Buffer.from([0, 0, 1]), from);
  if (idx < 0) return null;
  const begin = idx > from && buf[idx - 1] === 0 ? idx - 1 : idx;
  return { begin, end: idx + 3 };
}

function trimTrailingZeros(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.subarray(0, end);
}

/** Join NAL units into an Annex-B byte stream. */
function toAnnexB(nals) {
  const parts = [];
  for (const nal of nals) parts.push(START_CODE, nal);
  return Buffer.concat(parts);
}

/**
 * Groups a stream of NAL units into access units. x264 is run with one slice per picture, so
 * a picture ends at its VCL NAL; SPS/PPS/SEI/AUD before it belong to the same access unit.
 */
class AccessUnitBuilder {
  constructor() {
    this._pending = [];
  }

  /** @returns {Buffer[]|null} the completed access unit (array of NALs) or null */
  push(nal) {
    if (nalType(nal) === NAL.AUD) return null; // not needed for RTP
    this._pending.push(nal);
    if (isVcl(nal)) {
      const au = this._pending;
      this._pending = [];
      return au;
    }
    return null;
  }
}

module.exports = { START_CODE, NAL, nalType, isVcl, AnnexBParser, AccessUnitBuilder, toAnnexB };
