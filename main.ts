// png-squeeze-01 entry: lossless PNG re-encoder.
// Reads /input/i001..i008/image.png (1280x720 stored RGBA PNGs), writes
// losslessly re-encoded PNGs to /output/<id>/image.png.
// Strategy: per-instance colour-type reduction (palette / grey / RGB / RGBA,
// tRNS where it helps), per-scanline filter choice screened by real zlib-9
// size, and a hand-rolled optimal-parse DEFLATE encoder (zopfli-style) used
// where its work budget pays off, with zlib level 9 as the fallback.
// Deterministic: no clock, environment, or randomness is read anywhere.
// Node 22, erasable TypeScript only, Node stdlib only, no network.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { inflateSync, deflateSync, constants } from 'node:zlib';

const W = 1280;
const H = 720;
const IDS = ['i001', 'i002', 'i003', 'i004', 'i005', 'i006', 'i007', 'i008'];
// Mount points: the grader provides them as environment variables on every
// driver (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR); /input and /output are
// the in-container defaults. The paths are not a source of variation.
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- CRC32 (standard, table generated at load) ----------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc);
  return out;
}

// ---------- DEFLATE tables ----------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const LEN_CODE = new Uint16Array(259);
for (let s = 0; s < 29; s++) for (let l = LEN_BASE[s]; l < (s === 28 ? 259 : LEN_BASE[s + 1]); l++) LEN_CODE[l] = 257 + s;
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const DIST_CODE = new Uint16Array(32769);
for (let s = 0; s < 30; s++) for (let d = DIST_BASE[s]; d < (s === 29 ? 32769 : DIST_BASE[s + 1]); d++) DIST_CODE[d] = s;
const LEN_MAX = new Uint16Array(29);
for (let s = 0; s < 29; s++) LEN_MAX[s] = (s === 28 ? 258 : LEN_BASE[s + 1] - 1);

// ---------- length-limited Huffman ----------
function codeLengths(freq: Uint32Array, limit: number): Uint8Array | null {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  const order = syms.slice().sort((a, b) => freq[a] - freq[b] || a - b);
  const depth = new Uint16Array(n);
  let leaves = order.map((s) => ({ f: freq[s], syms: [s] }));
  const merged: { f: number; syms: number[] }[] = [];
  const popMin = () => {
    const a = leaves.length ? leaves[0] : null;
    const b = merged.length ? merged[0] : null;
    if (a && (!b || a.f <= b.f)) { leaves.shift(); return a; }
    merged.shift(); return b;
  };
  while (leaves.length + merged.length > 1) {
    const x = popMin();
    const y = popMin();
    for (const s of x.syms) depth[s]++;
    for (const s of y.syms) depth[s]++;
    merged.push({ f: x.f + y.f, syms: x.syms.concat(y.syms) });
  }
  for (const s of syms) lengths[s] = Math.min(depth[s] || 1, limit);
  const kraft = () => {
    let s = 0;
    for (const sym of syms) s += Math.pow(2, -lengths[sym]);
    return s;
  };
  if (kraft() > 1) {
    // Over-subscribed after clamping: lengthen symbols, preferring the
    // longest lengths (smallest Kraft reduction) to avoid overshooting.
    const byLen = syms.slice().sort((a, b) => lengths[b] - lengths[a] || freq[a] - freq[b]);
    let guard = 0;
    while (kraft() > 1 && guard++ < 100000) {
      let progressed = false;
      for (const s of byLen) {
        if (lengths[s] < limit) { lengths[s]++; progressed = true; break; }
      }
      if (!progressed) break;
    }
  }
  // A valid DEFLATE Huffman code must be complete (Kraft == 1). Clamping
  // can leave it incomplete; fall back to a flat complete code (shortest
  // lengths to the most frequent symbols) which always fits the limit.
  if (Math.abs(kraft() - 1) > 1e-9) {
    const n = syms.length;
    const L = Math.ceil(Math.log2(n));
    if (L > limit) return null;
    const a = (1 << L) - n; // symbols at length L-1
    const byFreq = syms.slice().sort((x, y) => freq[y] - freq[x] || x - y);
    for (let i = 0; i < n; i++) lengths[byFreq[i]] = i < a ? L - 1 : L;
    if (Math.abs(kraft() - 1) > 1e-9) return null;
  }
  return lengths;
}

function buildCodes(lengths: Uint8Array): { codes: Uint16Array; maxLen: number } {
  const n = lengths.length;
  const maxLen = Math.max(...lengths);
  const blCount = new Uint16Array(maxLen + 1);
  for (let i = 0; i < n; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const codes = new Uint16Array(n);
  let code = 0;
  const nextCode = new Uint16Array(maxLen + 1);
  for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l !== 0) { codes[i] = nextCode[l]; nextCode[l]++; }
  }
  return { codes, maxLen };
}

function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

class BitWriter {
  bytes: number[] = [];
  acc = 0;
  nbits = 0;
  writeBits(value: number, len: number): void {
    this.acc |= value << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  writeCode(code: number, len: number): void { this.writeBits(reverseBits(code, len), len); }
  finish(): Uint8Array {
    if (this.nbits > 0) { this.bytes.push(this.acc & 0xff); this.acc = 0; this.nbits = 0; }
    return new Uint8Array(this.bytes);
  }
}

function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- optimal-parse DEFLATE ----------
type Tokens = { lits: Uint16Array; lens: Uint16Array; dists: Uint16Array; cost: number };

function optimalParse(data: Uint8Array, litCost: Float64Array, lenCost: Float64Array, distCost: Float64Array, maxChain: number): Tokens {
  const n = data.length;
  const costs = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) costs[i] = Infinity;
  const tokLen = new Uint16Array(n + 1);
  const tokDist = new Uint16Array(n + 1);
  const HASH_BITS = 15;
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const recLen = new Uint16Array(32);
  const recDist = new Uint16Array(32);
  const hashAt = (i: number) => (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & ((1 << HASH_BITS) - 1));
  for (let i = 0; i < n; i++) {
    const ci = costs[i];
    if (ci === Infinity) continue;
    const lc = ci + litCost[data[i]];
    if (lc < costs[i + 1]) { costs[i + 1] = lc; tokLen[i + 1] = 1; tokDist[i + 1] = 0; }
    if (i + 3 <= n) {
      const h = hashAt(i);
      let chain = 0;
      const maxLen = Math.min(258, n - i);
      let nrec = 0;
      let bestSoFar = 2;
      let cur = head[h];
      while (cur !== -1 && chain < maxChain) {
        const dist = i - cur;
        if (dist > 32768) break;
        if (bestSoFar < maxLen && data[cur + bestSoFar] !== data[i + bestSoFar]) {
          cur = prev[cur];
          chain++;
          continue;
        }
        let len = 0;
        while (len < maxLen && data[cur + len] === data[i + len]) len++;
        if (len > bestSoFar) {
          bestSoFar = len;
          if (nrec < 32) { recLen[nrec] = len; recDist[nrec] = dist; nrec++; }
          if (len >= maxLen) break;
        }
        cur = prev[cur];
        chain++;
        if (bestSoFar >= maxLen) break;
      }
      for (let r = 0; r < nrec; r++) {
        const bestLen = recLen[r], bestDist = recDist[r];
        const dc = distCost[DIST_CODE[bestDist]];
        for (let s = 0; s < 29; s++) {
          const m = Math.min(LEN_MAX[s], bestLen);
          if (m < LEN_BASE[s]) break;
          const c = ci + lenCost[s] + LEN_EXTRA[s] + dc;
          if (c < costs[i + m]) { costs[i + m] = c; tokLen[i + m] = m; tokDist[i + m] = bestDist; }
        }
      }
      prev[i] = head[h];
      head[h] = i;
    }
  }
  const lits: number[] = [], lens: number[] = [], dists: number[] = [];
  let j = n;
  const rev: number[] = [];
  while (j > 0) {
    const l = tokLen[j];
    if (l === 0) throw new Error('optimalParse: unreachable position ' + j);
    rev.push(j);
    j -= l;
  }
  rev.reverse();
  for (const end of rev) {
    const l = tokLen[end];
    if (l === 1) { lits.push(data[end - 1]); lens.push(0); dists.push(0); }
    else { lits.push(LEN_CODE[l]); lens.push(l); dists.push(tokDist[end]); }
  }
  return { lits: Uint16Array.from(lits), lens: Uint16Array.from(lens), dists: Uint16Array.from(dists), cost: costs[n] };
}

function encodeBlock(tokens: Tokens, litLen: Uint8Array, distLen: Uint8Array): Uint8Array {
  const { lits, lens, dists } = tokens;
  const nTok = lits.length;
  const litCodes = buildCodes(litLen);
  const distCodes = buildCodes(distLen);
  let hlit = 286, hdist = 30;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const clSeq = new Uint8Array(hlit + hdist);
  clSeq.set(litLen.subarray(0, hlit), 0);
  clSeq.set(distLen.subarray(0, hdist), hlit);
  const clSyms: [number, number, number][] = [];
  let p = 0;
  while (p < clSeq.length) {
    const v = clSeq[p];
    let run = 1;
    while (p + run < clSeq.length && clSeq[p + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const take = Math.min(r, 138); clSyms.push([18, 7, take - 11]); r -= take; }
      if (r >= 3) { clSyms.push([17, 3, r - 3]); r = 0; }
      while (r > 0) { clSyms.push([0, 0, 0]); r--; }
    } else {
      clSyms.push([v, 0, 0]);
      let r = run - 1;
      while (r >= 3) { const take = Math.min(r, 6); clSyms.push([16, 2, take - 3]); r -= take; }
      while (r > 0) { clSyms.push([v, 0, 0]); r--; }
    }
    p += run;
  }
  const clFreq = new Uint32Array(19);
  for (const [s] of clSyms) clFreq[s]++;
  const clLen = codeLengths(clFreq, 7);
  if (clLen === null) throw new Error('encodeBlock: bad code-length code');
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLen[ORDER[hclen - 1]] === 0) hclen--;
  const clCodes = buildCodes(clLen);
  const w = new BitWriter();
  w.writeBits(1, 1);
  w.writeBits(2, 2);
  w.writeBits(hlit - 257, 5);
  w.writeBits(hdist - 1, 5);
  w.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.writeBits(clLen[ORDER[k]], 3);
  for (const [s, eb, ev] of clSyms) {
    w.writeCode(clCodes.codes[s], clLen[s]);
    if (eb) w.writeBits(ev, eb);
  }
  for (let t = 0; t < nTok; t++) {
    const sym = lits[t];
    w.writeCode(litCodes.codes[sym], litLen[sym]);
    if (lens[t] > 0) {
      const s = sym - 257;
      if (LEN_EXTRA[s]) w.writeBits(lens[t] - LEN_BASE[s], LEN_EXTRA[s]);
      const ds = DIST_CODE[dists[t]];
      w.writeCode(distCodes.codes[ds], distLen[ds]);
      if (DIST_EXTRA[ds]) w.writeBits(dists[t] - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  w.writeCode(litCodes.codes[256], litLen[256]);
  return w.finish();
}

// Two-iteration optimal encode (iteration 1: chain 64 for initial lengths;
// iteration 2: chain 1024 for the final parse). Returns the full zlib stream,
// or null if the Huffman tables are invalid.
function zoptEncode(data: Uint8Array): Uint8Array | null {
  const chains = [64, 1024];
  let litCost = new Float64Array(288).fill(8);
  let lenCost = new Float64Array(29).fill(8);
  let distCost = new Float64Array(30).fill(8);
  let tokens: Tokens | null = null;
  for (let it = 0; it < 2; it++) {
    tokens = optimalParse(data, litCost, lenCost, distCost, chains[it]);
    const litFreq = new Uint32Array(288);
    const distFreq = new Uint32Array(30);
    for (let t = 0; t < tokens.lits.length; t++) {
      litFreq[tokens.lits[t]]++;
      if (tokens.lens[t] > 0) distFreq[DIST_CODE[tokens.dists[t]]]++;
    }
    litFreq[256] = 1;
    const litLen = codeLengths(litFreq, 15);
    let distLen = codeLengths(distFreq, 15);
    if (litLen === null || distLen === null) return null;
    if (Math.max(...distLen) === 0) distLen[0] = 1;
    litCost = new Float64Array(288);
    for (let i = 0; i < 288; i++) litCost[i] = litLen[i] || 15;
    lenCost = new Float64Array(29);
    for (let s = 0; s < 29; s++) lenCost[s] = litLen[257 + s] || 15;
    distCost = new Float64Array(30);
    for (let i = 0; i < 30; i++) distCost[i] = distLen[i] || 15;
    if (it === 1) {
      const block = encodeBlock(tokens, litLen, distLen);
      const out = new Uint8Array(block.length + 6);
      out[0] = 0x78; out[1] = 0x9c;
      out.set(block, 2);
      const ad = adler32(data);
      out[out.length - 4] = (ad >>> 24) & 0xff;
      out[out.length - 3] = (ad >>> 16) & 0xff;
      out[out.length - 2] = (ad >>> 8) & 0xff;
      out[out.length - 1] = ad & 0xff;
      return out;
    }
  }
  return null;
}

// ---------- PNG decode / analysis / forms / filters ----------
function decodeStored(path: string): Uint8Array {
  const b = readFileSync(path);
  let at = 8;
  const idat: Buffer[] = [];
  while (at < b.length) {
    const len = b.readUInt32BE(at);
    const type = b.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') idat.push(b.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * 4;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  return rgba;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  else if (type === 2) for (let i = 0; i < n; i++) out[i] = cur[i] - (prev ? prev[i] : 0);
  else if (type === 3) for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev ? prev[i] : 0)) >> 1);
  else for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}

function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

const Z9 = { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY };
const Z4 = { level: 4, memLevel: 9 };

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

function filterAll(samples: Uint8Array, bpp: number, choice: FilterChoice): Uint8Array {
  const stride = W * bpp;
  const raw = new Uint8Array(H * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) { const r = new Uint8Array(stride + 1); r[0] = t; trial.push(r); }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? Z4 : { ...Z4, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

type Analysis = { opaque: boolean; grey: boolean; uniqueCount: number; colours: { rgba: number[]; word: number; count: number }[] | null };

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true, grey = true;
  const counts = new Map<number, number>();
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    const c = u32[i];
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const uniqueCount = counts.size;
  const colours = uniqueCount > 256 ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) as number };
  });
  return { opaque, grey, uniqueCount, colours };
}

function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v; else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function paletteOrder(colours: { rgba: number[]; word: number; count: number }[], order: string) {
  const lum = (c: { rgba: number[] }) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0, tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba: Uint8Array, colours: { rgba: number[]; word: number; count: number }[], order: string) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { plte, trns, indices };
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

type Form = { name: string; ct: number; bpp: number; samples: Uint8Array; plte: Uint8Array | null; trns: Uint8Array | null };

function formsOf(rgba: Uint8Array, a: Analysis): Form[] {
  const { opaque, grey, colours } = a;
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ name: `pal-${order}`, ct: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number, trns: Uint8Array | null = null;
  if (grey) { ct = opaque || key !== null ? 0 : 4; if (key !== null) trns = Uint8Array.of(0, key); }
  else { ct = opaque || key !== null ? 2 : 6; if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff); }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({ name: `ct${ct}`, ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

function z9size(raw: Uint8Array): number {
  return deflateSync(raw, Z9).length;
}

// ---------- PNG assembly ----------
function encodePng(form: Form, zstream: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H);
  ihdr[8] = 8; ihdr[9] = form.ct; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  parts.push(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  parts.push(chunk('IHDR', ihdr));
  if (form.plte) parts.push(chunk('PLTE', form.plte));
  if (form.trns) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', zstream));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- driver ----------
function main(): void {
  for (const id of IDS) {
    const rgba = decodeStored(`${INPUT_DIR}/${id}/image.png`);
    const a = analyse(rgba);
    const forms = formsOf(rgba, a);
    // Screen every (form, filter) by real zlib-9 size and keep the best.
    // Screening must cover all forms: a form tied at filter 0 can be far
    // better at its best per-row filter (e.g. grey ct0+brute vs palette).
    let bestForm: Form | null = null;
    let bestRaw: Uint8Array | null = null;
    let bestSize = Infinity;
    for (const f of forms) {
      // 'minsum' never wins on these screenshots; 0 / pairs / brute cover
      // the winners (filter 0 for flat, pairs for rich, brute for alpha/grey).
      const filterChoices: FilterChoice[] = [0, 'pairs'];
      if (f.ct !== 3) filterChoices.push('brute');
      for (const fc of filterChoices) {
        const raw = filterAll(f.samples, f.bpp, fc);
        const s = z9size(raw);
        if (s < bestSize) { bestSize = s; bestForm = f; bestRaw = raw; }
      }
    }
    if (bestForm === null || bestRaw === null) throw new Error('no form for ' + id);
    // Encoder choice by WORK, never by clock: the optimal parser pays off
    // when the filtered stream is not too large and the image repeats
    // (few unique colours), and for palette / colour forms where long
    // matches dominate; for grey forms zlib level 9 is nearly as good and
    // far cheaper, so it is used there. Otherwise zlib level 9.
    const rawLen = bestRaw.length;
    const useOpt = rawLen <= 2765520 && a.uniqueCount <= 10000 && bestForm.ct !== 0 && bestForm.ct !== 4;
    let zstream: Uint8Array;
    if (useOpt) {
      const opt = zoptEncode(bestRaw);
      if (opt !== null && opt.length < bestSize) zstream = opt;
      else zstream = deflateSync(bestRaw, Z9);
    } else {
      zstream = deflateSync(bestRaw, Z9);
    }
    const png = encodePng(bestForm, zstream);
    const dir = `${OUTPUT_DIR}/${id}`;
    mkdirSync(dir, { recursive: true });
    // Clean only the directory's contents, never the directory itself.
    for (const name of readdirSync(dir)) rmSync(`${dir}/${name}`, { recursive: true, force: true });
    writeFileSync(`${dir}/image.png`, png);
  }
}

main();
