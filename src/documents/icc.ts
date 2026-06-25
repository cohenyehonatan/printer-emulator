/**
 * Minimal ICC matrix-shaper color management (bounded, dependency-free).
 *
 * This module gives the raster pipeline real (colorimetric) color management for
 * the one case the decoder previously got wrong: an **AdobeRGB** raster page was
 * passed through as if it were sRGB, even though AdobeRGB has wider green/red
 * primaries and a different (≈2.2 pure-power) gamma. Here we parse — and provide
 * built-in — **matrix-shaper** ICC profiles and apply a device→PCS→device
 * transform so AdobeRGB pixels are converted to colorimetrically-correct sRGB
 * before they are encoded into a PNG.
 *
 * Scope is deliberately narrow: **matrix/TRC (matrix-shaper) RGB profiles only**.
 * A matrix-shaper profile models a device's color as
 *   XYZ_PCS = M · [ TRC_r(r), TRC_g(g), TRC_b(b) ]ᵀ
 * where M (the colorant matrix, `[rXYZ gXYZ bXYZ]`) takes linear device RGB to
 * PCS XYZ, and each per-channel TRC (tone reproduction curve) linearizes a device
 * code value. We do NOT handle A2B/B2A LUT profiles (`mft1`/`mft2`/`mAB `/`mBA `),
 * named-color, device-link, or perceptual/saturation rendering-intent gamut
 * mapping. A non-matrix-shaper profile parses to `null`, and the caller then
 * treats the source as already-sRGB (passthrough) rather than guessing.
 *
 * PCS / white point: ICC display-class PCS is **D50**. Both built-in profiles
 * (sRGB and AdobeRGB) carry **D50-adapted** colorant matrices (their native D65
 * primaries Bradford-adapted to D50 — see ADAPTATION below), so the round-trip
 * AdobeRGB→XYZ(D50)→sRGB is colorimetrically consistent: the shared white point
 * means neutral grays map near-identically and only the gamut/gamma difference
 * moves a pixel.
 *
 * Out-of-gamut handling is a **simple colorimetric clip**: after the inverse
 * output matrix, linear channels are clamped to [0,1] before the output TRC.
 * There is no perceptual gamut compression — a color outside sRGB's gamut is
 * clipped to the nearest sRGB primary face (so a saturated AdobeRGB green that
 * sRGB cannot reach lands on sRGB's most-saturated green).
 *
 * Robustness: parsing never throws on malformed/truncated bytes — a bad tag,
 * a short buffer, or an unsupported curve type yields `null` (treat as not a
 * matrix-shaper profile). The transform never throws either; it operates on
 * normalized floats and re-quantizes to the sample's bit depth.
 *
 * Binary format references: ICC.1:2010 (ICC v4) — profile header (128 bytes,
 * `acsp` signature at offset 36), tag table (count + 12-byte entries: 4-byte
 * signature, 4-byte offset, 4-byte size), `XYZType` (`XYZ ` data, s15Fixed16
 * X,Y,Z), `curveType` (`curv`: count + uint16 entries, or a single uint16 = a
 * u8Fixed8 gamma), and `parametricCurveType` (`para`: a function-type uint16 +
 * s15Fixed16 parameters).
 */

/**
 * A parsed tone reproduction curve (TRC) for one channel. The forward direction
 * maps a normalized device code (0..1) to a normalized linear value (0..1); the
 * inverse maps linear back to device. Three shapes cover the matrix-shaper world:
 *   - `gamma`: a single power-law exponent (`curveType` with one entry, or
 *     `parametricCurveType` function-type 0). Forward: `lin = code^g`.
 *   - `table`: a sampled 1-D LUT (`curveType` with N entries), linearly
 *     interpolated; inverse by binary-search + linear interpolation. Entries are
 *     the normalized curve outputs (uint16/65535).
 *   - `parametric`: an ICC `parametricCurveType` (function-types 0–4). We support
 *     type 0 (pure gamma) and type 3 (the sRGB-style piecewise
 *     `X >= d ? ((a*X+b)^g) : c*X`), which together cover sRGB and AdobeRGB.
 */
export type Trc =
  | { kind: 'gamma'; gamma: number }
  | { kind: 'table'; samples: number[] }
  | {
      kind: 'parametric';
      g: number;
      a: number;
      b: number;
      c: number;
      d: number;
      e: number;
      f: number;
    };

/**
 * A parsed matrix-shaper ICC profile: the colorant matrix `matrix` (device→PCS
 * XYZ, D50; `matrix[row][col]`, column = channel so column 0 = rXYZ) and the
 * three per-channel TRCs. Produced by `parseIccProfile` and consumed by
 * `applyIccRgb`.
 */
export interface MatrixShaperProfile {
  /** 3×3 device-RGB → PCS XYZ (D50). matrix[i][j]: row i of XYZ, col j of RGB. */
  matrix: number[][];
  /** Per-channel tone reproduction curves (R, G, B). */
  trc: [Trc, Trc, Trc];
}

// ── ICC binary layout constants (ICC.1:2010) ──────────────────────────────
const ICC_HEADER_LEN = 128;
const ICC_ACSP_OFFSET = 36; // 'acsp' profile file signature
const ICC_TAG_COUNT_OFFSET = 128; // uint32 tag count, then 12-byte entries
const ICC_TAG_ENTRY_LEN = 12;

const SIG_ACSP = 0x61637370; // 'acsp'
const SIG_XYZ = 0x58595a20; // 'XYZ ' (XYZType)
const SIG_CURV = 0x63757276; // 'curv' (curveType)
const SIG_PARA = 0x70617261; // 'para' (parametricCurveType)

// Tag signatures we read for a matrix-shaper RGB profile.
const TAG_RXYZ = 0x7258595a; // 'rXYZ'
const TAG_GXYZ = 0x6758595a; // 'gXYZ'
const TAG_BXYZ = 0x6258595a; // 'bXYZ'
const TAG_RTRC = 0x72545243; // 'rTRC'
const TAG_GTRC = 0x67545243; // 'gTRC'
const TAG_BTRC = 0x62545243; // 'bTRC'

/**
 * Parse a matrix-shaper ICC profile from a Buffer. Returns the colorant matrix
 * (device→XYZ, D50) plus the three TRCs, or `null` when the bytes are not a
 * usable matrix-shaper RGB profile (missing `acsp` signature, missing any of the
 * six rXYZ/gXYZ/bXYZ/rTRC/gTRC/bTRC tags, an unsupported curve, or any structural
 * damage). Never throws — every read is bounds-checked and a failure collapses to
 * `null` so the caller can fall back to passthrough.
 */
export function parseIccProfile(bytes: Buffer): MatrixShaperProfile | null {
  if (bytes.length < ICC_HEADER_LEN) return null;
  if (readU32(bytes, ICC_ACSP_OFFSET) !== SIG_ACSP) return null;

  const tags = readTagTable(bytes);
  if (!tags) return null;

  const rx = readXyzTag(bytes, tags, TAG_RXYZ);
  const gx = readXyzTag(bytes, tags, TAG_GXYZ);
  const bx = readXyzTag(bytes, tags, TAG_BXYZ);
  if (!rx || !gx || !bx) return null;

  const rt = readTrcTag(bytes, tags, TAG_RTRC);
  const gt = readTrcTag(bytes, tags, TAG_GTRC);
  const bt = readTrcTag(bytes, tags, TAG_BTRC);
  if (!rt || !gt || !bt) return null;

  // Colorant matrix columns are the rXYZ/gXYZ/bXYZ vectors (device→PCS XYZ).
  const matrix = [
    [rx[0], gx[0], bx[0]],
    [rx[1], gx[1], bx[1]],
    [rx[2], gx[2], bx[2]],
  ];
  return { matrix, trc: [rt, gt, bt] };
}

/** Read the tag table into a signature→{offset,size} map. Null on damage. */
function readTagTable(
  bytes: Buffer
): Map<number, { offset: number; size: number }> | null {
  const count = readU32(bytes, ICC_TAG_COUNT_OFFSET);
  // Guard against an absurd/corrupt count overrunning the buffer.
  const tableEnd =
    ICC_TAG_COUNT_OFFSET + 4 + count * ICC_TAG_ENTRY_LEN;
  if (count <= 0 || count > 4096 || tableEnd > bytes.length) return null;

  const tags = new Map<number, { offset: number; size: number }>();
  for (let i = 0; i < count; i++) {
    const base = ICC_TAG_COUNT_OFFSET + 4 + i * ICC_TAG_ENTRY_LEN;
    const sig = readU32(bytes, base);
    const offset = readU32(bytes, base + 4);
    const size = readU32(bytes, base + 8);
    tags.set(sig, { offset, size });
  }
  return tags;
}

/** Read an XYZType tag as [X,Y,Z] (s15Fixed16). Null if absent/short/wrong type. */
function readXyzTag(
  bytes: Buffer,
  tags: Map<number, { offset: number; size: number }>,
  sig: number
): [number, number, number] | null {
  const entry = tags.get(sig);
  if (!entry) return null;
  const off = entry.offset;
  // XYZType: 'XYZ ' (4) + reserved (4) + at least one XYZ triple (12).
  if (off + 8 + 12 > bytes.length) return null;
  if (readU32(bytes, off) !== SIG_XYZ) return null;
  const x = readS15Fixed16(bytes, off + 8);
  const y = readS15Fixed16(bytes, off + 12);
  const z = readS15Fixed16(bytes, off + 16);
  return [x, y, z];
}

/** Read a TRC tag (`curveType` or `parametricCurveType`). Null on damage. */
function readTrcTag(
  bytes: Buffer,
  tags: Map<number, { offset: number; size: number }>,
  sig: number
): Trc | null {
  const entry = tags.get(sig);
  if (!entry) return null;
  const off = entry.offset;
  if (off + 8 > bytes.length) return null;
  const type = readU32(bytes, off);
  if (type === SIG_CURV) return readCurveType(bytes, off);
  if (type === SIG_PARA) return readParametricType(bytes, off);
  return null;
}

/**
 * Read a `curveType` (`curv`): 4-byte sig + 4-byte reserved + uint32 count, then
 * `count` uint16 entries. count 0 ⇒ identity (gamma 1). count 1 ⇒ a single
 * u8Fixed8 gamma. count ≥ 2 ⇒ a sampled LUT (entries / 65535).
 */
function readCurveType(bytes: Buffer, off: number): Trc | null {
  if (off + 12 > bytes.length) return null;
  const count = readU32(bytes, off + 8);
  if (count === 0) return { kind: 'gamma', gamma: 1 };
  if (count === 1) {
    // Single entry is a u8Fixed8 gamma (8.8 fixed point / 256).
    if (off + 14 > bytes.length) return null;
    const g = readU16(bytes, off + 12) / 256;
    return { kind: 'gamma', gamma: g };
  }
  if (count > 1 << 20) return null; // sanity bound on table size
  const dataEnd = off + 12 + count * 2;
  if (dataEnd > bytes.length) return null;
  const samples = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    samples[i] = readU16(bytes, off + 12 + i * 2) / 65535;
  }
  return { kind: 'table', samples };
}

/**
 * Read a `parametricCurveType` (`para`): 4-byte sig + 4-byte reserved + uint16
 * function-type + 2-byte reserved, then the s15Fixed16 parameters in the order
 * defined by ICC for the function type:
 *   type 0: g                       → Y = X^g
 *   type 1: g, a, b                 → Y = (a*X+b)^g for X≥-b/a else 0
 *   type 2: g, a, b, c              → + c offset
 *   type 3: g, a, b, c, d           → Y = (a*X+b)^g for X≥d else c*X  (sRGB shape)
 *   type 4: g, a, b, c, d, e, f
 * We normalize each into the general 7-parameter (g,a,b,c,d,e,f) form so the
 * forward/inverse evaluators are uniform.
 */
function readParametricType(bytes: Buffer, off: number): Trc | null {
  if (off + 12 > bytes.length) return null;
  const fn = readU16(bytes, off + 8);
  const pStart = off + 12;
  // Parameter counts per function type 0..4.
  const counts = [1, 3, 4, 5, 7];
  if (fn > 4) return null;
  const n = counts[fn];
  if (pStart + n * 4 > bytes.length) return null;
  const p = new Array<number>(n);
  for (let i = 0; i < n; i++) p[i] = readS15Fixed16(bytes, pStart + i * 4);

  // Map to the general (g,a,b,c,d,e,f) form. Defaults: identity-ish.
  let g = 1,
    a = 1,
    b = 0,
    c = 0,
    d = 0,
    e = 0,
    f = 0;
  switch (fn) {
    case 0:
      g = p[0];
      // Pure gamma: Y = X^g. Represent directly as a gamma curve.
      return { kind: 'gamma', gamma: g };
    case 1:
      [g, a, b] = p;
      d = -b / a; // threshold below which Y = 0
      break;
    case 2:
      [g, a, b, c] = p;
      d = -b / a;
      e = c;
      f = c;
      break;
    case 3:
      [g, a, b, c, d] = p;
      break;
    case 4:
      [g, a, b, c, d, e, f] = p;
      break;
  }
  return { kind: 'parametric', g, a, b, c, d, e, f };
}

/**
 * Forward TRC: normalized device code (0..1) → normalized linear (0..1).
 *   - gamma:      code^g
 *   - table:      linear-interpolated LUT lookup
 *   - parametric: ICC type-4 general form  Y = X≥d ? (a*X+b)^g + e : c*X + f
 */
function trcForward(trc: Trc, code: number): number {
  const x = clamp01(code);
  switch (trc.kind) {
    case 'gamma':
      return Math.pow(x, trc.gamma);
    case 'table':
      return interpTable(trc.samples, x);
    case 'parametric': {
      const { g, a, b, c, d, e, f } = trc;
      return x >= d ? Math.pow(a * x + b, g) + e : c * x + f;
    }
  }
}

/**
 * Inverse TRC: normalized linear (0..1) → normalized device code (0..1).
 *   - gamma:      lin^(1/g)
 *   - table:      inverse LUT (binary-search + linear interpolation)
 *   - parametric: invert the active piece of the ICC type-4 form, choosing the
 *     branch by the linear threshold value at X=d.
 */
function trcInverse(trc: Trc, lin: number): number {
  const y = clamp01(lin);
  switch (trc.kind) {
    case 'gamma':
      return trc.gamma === 0 ? 0 : Math.pow(y, 1 / trc.gamma);
    case 'table':
      return invertTable(trc.samples, y);
    case 'parametric': {
      const { g, a, b, c, d, e, f } = trc;
      // Linear-piece threshold in Y: value of the lower branch at X=d.
      const yThresh = c * d + f;
      if (y <= yThresh) {
        return c === 0 ? 0 : (y - f) / c;
      }
      // Upper branch: Y = (a*X+b)^g + e  ⇒  X = ((Y-e)^(1/g) - b) / a.
      const inner = g === 0 ? 0 : Math.pow(Math.max(0, y - e), 1 / g);
      return a === 0 ? 0 : (inner - b) / a;
    }
  }
}

/** Linear interpolation into a normalized sample table (x in 0..1). */
function interpTable(samples: number[], x: number): number {
  const n = samples.length;
  if (n === 0) return x;
  if (n === 1) return samples[0];
  const pos = clamp01(x) * (n - 1);
  const i = Math.floor(pos);
  if (i >= n - 1) return samples[n - 1];
  const frac = pos - i;
  return samples[i] + (samples[i + 1] - samples[i]) * frac;
}

/**
 * Inverse of `interpTable`: given a normalized output `y`, find the input `x`
 * (0..1) whose interpolated curve value is `y`. The curve is assumed monotonic
 * non-decreasing (true for display TRCs); a binary search locates the bracketing
 * pair and linear interpolation refines within it.
 */
function invertTable(samples: number[], y: number): number {
  const n = samples.length;
  if (n === 0) return y;
  if (n === 1) return 0;
  const target = clamp01(y);
  if (target <= samples[0]) return 0;
  if (target >= samples[n - 1]) return 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = samples[hi] - samples[lo];
  const frac = span <= 0 ? 0 : (target - samples[lo]) / span;
  return (lo + frac) / (n - 1);
}

/**
 * Apply an input→output matrix-shaper transform to one RGB pixel. The pipeline is
 * the standard ICC colorimetric (matrix) conversion:
 *   1. normalize each device code to 0..1 (÷ `maxval`),
 *   2. linearize via the input TRCs,
 *   3. linear device RGB → PCS XYZ (D50) via the input colorant matrix,
 *   4. PCS XYZ → linear output RGB via the inverse output colorant matrix,
 *   5. clamp linear output to [0,1] (simple colorimetric gamut clip),
 *   6. re-encode via the output TRCs' inverse and re-quantize (× `maxval`).
 *
 * `maxval` is 255 for 8-bit samples or 65535 for 16-bit; the same code path
 * serves both since it works in normalized floats. The returned triple is rounded
 * and clamped to [0, maxval]. Pure; never throws.
 */
export function applyIccPixel(
  r: number,
  g: number,
  b: number,
  input: MatrixShaperProfile,
  output: MatrixShaperProfile,
  maxval: number
): [number, number, number] {
  const outInv = invert3x3(output.matrix);
  if (!outInv) return [r, g, b]; // degenerate output matrix → passthrough

  // 1–2: normalize + linearize the input device codes.
  const lin = [
    trcForward(input.trc[0], r / maxval),
    trcForward(input.trc[1], g / maxval),
    trcForward(input.trc[2], b / maxval),
  ];

  // 3: linear input RGB → PCS XYZ (D50).
  const xyz = mat3MulVec(input.matrix, lin);

  // 4: PCS XYZ → linear output RGB.
  const outLin = mat3MulVec(outInv, xyz);

  // 5–6: gamut-clip to [0,1], re-encode via the output TRC inverse, quantize.
  const enc = [
    trcInverse(output.trc[0], clamp01(outLin[0])),
    trcInverse(output.trc[1], clamp01(outLin[1])),
    trcInverse(output.trc[2], clamp01(outLin[2])),
  ];
  return [
    quantize(enc[0], maxval),
    quantize(enc[1], maxval),
    quantize(enc[2], maxval),
  ];
}

/**
 * Convenience overload used by the decoder: transform an [r,g,b] tuple with the
 * given `maxval`. Equivalent to `applyIccPixel` but tuple-in/tuple-out for the
 * common call shape. Pure; never throws.
 */
export function applyIccRgb(
  rgb: [number, number, number],
  input: MatrixShaperProfile,
  output: MatrixShaperProfile,
  maxval: number
): [number, number, number] {
  return applyIccPixel(rgb[0], rgb[1], rgb[2], input, output, maxval);
}

// ── 3×3 linear algebra (small, allocation-light) ──────────────────────────

/** Multiply a 3×3 matrix by a 3-vector. */
function mat3MulVec(m: number[][], v: number[]): number[] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Invert a 3×3 matrix (cofactor/adjugate). Returns null if (near-)singular. */
function invert3x3(m: number[][]): number[][] | null {
  const a = m[0][0],
    b = m[0][1],
    c = m[0][2],
    d = m[1][0],
    e = m[1][1],
    f = m[1][2],
    g = m[2][0],
    h = m[2][1],
    i = m[2][2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  return [
    [A / det, D / det, G / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det],
  ];
}

// ── Bounded byte readers (never throw) ────────────────────────────────────

function readU32(buf: Buffer, off: number): number {
  if (off < 0 || off + 4 > buf.length) return 0;
  return buf.readUInt32BE(off);
}

function readU16(buf: Buffer, off: number): number {
  if (off < 0 || off + 2 > buf.length) return 0;
  return buf.readUInt16BE(off);
}

/** Read a signed 15.16 fixed-point number (ICC s15Fixed16Number). */
function readS15Fixed16(buf: Buffer, off: number): number {
  if (off < 0 || off + 4 > buf.length) return 0;
  return buf.readInt32BE(off) / 65536;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function quantize(normalized: number, maxval: number): number {
  const v = Math.round(clamp01(normalized) * maxval);
  return v < 0 ? 0 : v > maxval ? maxval : v;
}
