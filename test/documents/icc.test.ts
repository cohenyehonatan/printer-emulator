import { describe, it, expect } from 'vitest';
import {
  parseIccProfile,
  applyIccRgb,
  applyIccPixel,
  type MatrixShaperProfile,
} from '../../src/documents/icc.js';
import {
  ADOBE_RGB_PROFILE,
  SRGB_PROFILE,
} from '../../src/documents/icc-profiles.js';

/**
 * Hand-build a minimal matrix-shaper ICC profile Buffer: a 128-byte header (with
 * the `acsp` file signature at offset 36), a tag table for the six matrix-shaper
 * tags (rXYZ/gXYZ/bXYZ + rTRC/gTRC/bTRC), and their tag data. The XYZ tags carry
 * a known colorant matrix (column = channel) and the TRCs a known single-value
 * gamma (curveType count 1 = u8Fixed8 gamma) — so a parse round-trips to the
 * exact matrix + gamma we put in. This exercises `parseIccProfile`'s real binary
 * walk, independent of the built-in constants.
 */
function buildMatrixShaperProfile(opts: {
  /** matrix[i][j]: row i of XYZ, col j of RGB (col 0 = rXYZ …). */
  matrix: number[][];
  /** Per-channel gamma; one u8Fixed8 value each. */
  gamma: [number, number, number];
}): Buffer {
  const s15 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Math.round(v * 65536), 0);
    return b;
  };
  // XYZType: 'XYZ ' + 4 reserved + 3 s15Fixed16.
  const xyzTag = (col: number): Buffer =>
    Buffer.concat([
      Buffer.from('XYZ '),
      Buffer.alloc(4),
      s15(opts.matrix[0][col]),
      s15(opts.matrix[1][col]),
      s15(opts.matrix[2][col]),
    ]);
  // curveType with count 1: 'curv' + 4 reserved + uint32 count(1) + u8Fixed8.
  const curvTag = (g: number): Buffer => {
    const b = Buffer.alloc(14);
    b.write('curv', 0);
    b.writeUInt32BE(1, 8);
    b.writeUInt16BE(Math.round(g * 256), 12);
    return b;
  };

  const tagData: { sig: string; data: Buffer }[] = [
    { sig: 'rXYZ', data: xyzTag(0) },
    { sig: 'gXYZ', data: xyzTag(1) },
    { sig: 'bXYZ', data: xyzTag(2) },
    { sig: 'rTRC', data: curvTag(opts.gamma[0]) },
    { sig: 'gTRC', data: curvTag(opts.gamma[1]) },
    { sig: 'bTRC', data: curvTag(opts.gamma[2]) },
  ];

  const header = Buffer.alloc(128);
  header.write('acsp', 36); // profile file signature

  const tagCount = tagData.length;
  const tableLen = 4 + tagCount * 12;
  // Tag data is laid out right after the tag table.
  let cursor = 128 + tableLen;
  const table = Buffer.alloc(tableLen);
  table.writeUInt32BE(tagCount, 0);
  const datas: Buffer[] = [];
  tagData.forEach((t, i) => {
    const base = 4 + i * 12;
    table.write(t.sig, base);
    table.writeUInt32BE(cursor, base + 4);
    table.writeUInt32BE(t.data.length, base + 8);
    datas.push(t.data);
    cursor += t.data.length;
  });

  return Buffer.concat([header, table, ...datas]);
}

describe('parseIccProfile', () => {
  it('recovers the colorant matrix + gamma from a matrix-shaper profile', () => {
    const matrix = [
      [0.4, 0.35, 0.14],
      [0.22, 0.71, 0.06],
      [0.01, 0.09, 0.71],
    ];
    const bytes = buildMatrixShaperProfile({
      matrix,
      gamma: [2.2, 2.2, 2.2],
    });

    const profile = parseIccProfile(bytes);
    expect(profile).not.toBeNull();
    // Matrix recovered within s15Fixed16 (1/65536) tolerance.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(profile!.matrix[i][j]).toBeCloseTo(matrix[i][j], 4);
      }
    }
    // Each TRC is a gamma curve with the value we put in (u8Fixed8 = /256).
    for (const trc of profile!.trc) {
      expect(trc.kind).toBe('gamma');
      if (trc.kind === 'gamma') {
        expect(trc.gamma).toBeCloseTo(2.2, 2);
      }
    }
  });

  it('parses the AdobeRGB gamma 2.19921875 from a hand-built profile', () => {
    // 563/256 = 2.19921875 round-trips exactly through u8Fixed8 (×256 = 563).
    const bytes = buildMatrixShaperProfile({
      matrix: ADOBE_RGB_PROFILE.matrix,
      gamma: [563 / 256, 563 / 256, 563 / 256],
    });
    const profile = parseIccProfile(bytes);
    expect(profile).not.toBeNull();
    const trc = profile!.trc[0];
    expect(trc.kind).toBe('gamma');
    if (trc.kind === 'gamma') {
      expect(trc.gamma).toBeCloseTo(2.19921875, 6);
    }
    // Colorant matrix matches the built-in AdobeRGB D50-adapted values.
    expect(profile!.matrix[0][0]).toBeCloseTo(0.60972, 4);
    expect(profile!.matrix[1][1]).toBeCloseTo(0.625671, 4);
  });

  it('returns null for non-ICC / malformed bytes (no acsp, too short, garbage)', () => {
    expect(parseIccProfile(Buffer.alloc(0))).toBeNull();
    expect(parseIccProfile(Buffer.alloc(128))).toBeNull(); // no acsp
    const noAcsp = Buffer.alloc(200);
    noAcsp.write('XXXX', 36);
    expect(parseIccProfile(noAcsp)).toBeNull();
    // acsp present but no tag table / missing tags.
    const acspOnly = Buffer.alloc(140);
    acspOnly.write('acsp', 36);
    expect(parseIccProfile(acspOnly)).toBeNull();
  });

  it('returns null when a required matrix-shaper tag is missing', () => {
    // Build a full profile then corrupt the rXYZ tag signature in the table.
    const bytes = buildMatrixShaperProfile({
      matrix: SRGB_PROFILE.matrix,
      gamma: [2.2, 2.2, 2.2],
    });
    bytes.write('zzzz', 128 + 4); // clobber the first tag's signature (rXYZ)
    expect(parseIccProfile(bytes)).toBeNull();
  });

  it('never throws on random/truncated bytes', () => {
    for (let len = 0; len < 200; len += 7) {
      const b = Buffer.alloc(len);
      for (let i = 0; i < len; i++) b[i] = (i * 37) & 0xff;
      if (len >= 40) b.write('acsp', 36); // make some look ICC-ish
      expect(() => parseIccProfile(b)).not.toThrow();
    }
  });
});

/**
 * AdobeRGB → sRGB reference vectors, computed INDEPENDENTLY of the production
 * code path. The reference uses the same published math the built-in profiles
 * encode (AdobeRGB gamma 563/256 to linear; AdobeRGB D50-adapted matrix to XYZ;
 * sRGB D50-adapted matrix⁻¹ back to linear; sRGB piecewise encode; clip to
 * [0,1]; ×255). The expected outputs below were produced by a standalone Node
 * script using these formulas (documented in the module headers):
 *
 *   AdobeRGB white  (255,255,255) → sRGB (255,255,255)   — shared D50 white
 *   AdobeRGB black  (0,0,0)       → sRGB (0,0,0)
 *   AdobeRGB gray   (128,128,128) → sRGB (129,129,129)   — neutral, ±1 of identity
 *   AdobeRGB green  (100,150,50)  → sRGB (66,151,34)      — non-trivial, in-gamut:
 *       R/B drop markedly because AdobeRGB's wider primaries need less sRGB to
 *       reach the same color — proves the matrix (not just a clip) is applied.
 *   AdobeRGB pure green (0,255,0) → sRGB (0,255,0)        — saturated primary
 *       clips to the sRGB green corner (out-of-gamut → simple clip).
 *
 * Tolerance is ±2 codes (independent rounding may differ in the last bit).
 */
describe('applyIccRgb — AdobeRGB → sRGB (independent reference vectors)', () => {
  const A = ADOBE_RGB_PROFILE;
  const S = SRGB_PROFILE;
  const near = (got: number[], want: number[], tol = 2): void => {
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(tol);
    }
  };

  it('white maps to white (shared D50 white point)', () => {
    near(applyIccRgb([255, 255, 255], A, S, 255), [255, 255, 255]);
  });

  it('black maps to black', () => {
    near(applyIccRgb([0, 0, 0], A, S, 255), [0, 0, 0]);
  });

  it('neutral gray maps near-identically (≈128)', () => {
    near(applyIccRgb([128, 128, 128], A, S, 255), [129, 129, 129]);
  });

  it('an in-gamut green shifts notably (matrix, not just clip): (100,150,50)→(66,151,34)', () => {
    const out = applyIccRgb([100, 150, 50], A, S, 255);
    near(out, [66, 151, 34]);
    // The R and B channels drop substantially from the AdobeRGB input — the
    // conversion is NOT a passthrough.
    expect(out[0]).toBeLessThan(100 - 20);
    expect(out[2]).toBeLessThan(50 - 10);
  });

  it('a saturated AdobeRGB green clips to the sRGB green corner: (0,255,0)→(0,255,0)', () => {
    near(applyIccRgb([0, 255, 0], A, S, 255), [0, 255, 0]);
  });

  it('16-bit gray (32768) maps near-identically (≈33030)', () => {
    near(
      applyIccPixel(32768, 32768, 32768, A, S, 65535),
      [33030, 33030, 33030],
      4
    );
  });

  it('an identity transform (sRGB → sRGB) round-trips within ±1', () => {
    near(applyIccRgb([100, 150, 50], S, S, 255), [100, 150, 50], 1);
    near(applyIccRgb([200, 100, 100], S, S, 255), [200, 100, 100], 1);
  });

  it('is pure / never throws on extreme values', () => {
    expect(() => applyIccRgb([0, 0, 0], A, S, 255)).not.toThrow();
    expect(() => applyIccRgb([255, 255, 255], A, S, 255)).not.toThrow();
  });
});

describe('applyIccPixel — degenerate output matrix falls back to passthrough', () => {
  it('returns the input unchanged when the output matrix is singular', () => {
    const singular: MatrixShaperProfile = {
      matrix: [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
      trc: ADOBE_RGB_PROFILE.trc,
    };
    expect(applyIccPixel(10, 20, 30, ADOBE_RGB_PROFILE, singular, 255)).toEqual([
      10, 20, 30,
    ]);
  });
});
