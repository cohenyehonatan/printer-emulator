/**
 * Built-in matrix-shaper ICC profiles: sRGB and AdobeRGB (1998).
 *
 * These are the two profiles the raster pipeline needs to convert an AdobeRGB
 * raster page to sRGB (see `raster-decode.ts`). Rather than embed and parse real
 * `.icc` bytes at runtime, the colorant matrices and TRCs are provided as
 * validated constants in the same `MatrixShaperProfile` shape `parseIccProfile`
 * produces — so `applyIccRgb` treats a built-in profile identically to a parsed
 * one. (`icc.ts`'s parser is still exercised by tests against hand-built profile
 * bytes; this module is the "known-good profile" supply for the transform.)
 *
 * ── Colorant matrices (device→PCS XYZ, D50) ──
 * ICC display-class PCS is D50, so both matrices are **D50-adapted**: built from
 * each space's native D65 primaries and white, then chromatically adapted to D50
 * via the **Bradford** transform. Computing both with the *same* method and the
 * *same* D50 target keeps the round-trip colorimetrically consistent (a shared
 * white point ⇒ neutrals are preserved across the conversion; only the
 * gamut/gamma difference moves a pixel).
 *
 * Source chromaticities (CIE xy):
 *   sRGB / Rec.709:   R(0.6400, 0.3300)  G(0.3000, 0.6000)  B(0.1500, 0.0600)
 *   AdobeRGB (1998):  R(0.6400, 0.3300)  G(0.2100, 0.7100)  B(0.1500, 0.0600)
 *   white (both): D65 xy (0.3127, 0.3290); PCS target: D50 xy (0.34567, 0.35850)
 *   Bradford cone-response matrix per Lindbloom (the standard ICC adaptation).
 *
 * The resulting D50-adapted matrices below match the values stored in the
 * canonical sRGB IEC61966-2.1 and AdobeRGB(1998) ICC profiles to s15Fixed16
 * precision (e.g. sRGB rXYZ ≈ 0.4361/0.2225/0.0139; AdobeRGB rXYZ ≈
 * 0.6097/0.3111/0.0195). The white-point column sum of each is the D50 white XYZ
 * (0.96422, 1.00000, 0.82521), confirming the adaptation.
 *
 * ── TRCs ──
 *   - sRGB: the IEC 61966-2.1 piecewise transfer function, expressed as an ICC
 *     `parametricCurveType` function-type 3 (g=2.4, a=1/1.055, b=0.055/1.055,
 *     c=1/12.92, d=0.04045). Forward (code→linear):
 *       lin = code ≤ 0.04045 ? code/12.92 : ((code+0.055)/1.055)^2.4.
 *   - AdobeRGB: a pure power-law gamma of **563/256 = 2.19921875** (the value the
 *     AdobeRGB(1998) spec and its ICC profile use). Forward: lin = code^2.19921875.
 *
 * Both profiles are constants here, validated against the published numbers
 * above; they are not re-derived at runtime.
 */

import type { MatrixShaperProfile, Trc } from './icc.js';

/**
 * The sRGB IEC 61966-2.1 transfer curve as an ICC parametric (type-3) TRC. The
 * normalized general form evaluated by `icc.ts` is
 *   X ≥ d ? (a*X + b)^g : c*X
 * which with these parameters is the standard sRGB piecewise function.
 */
const SRGB_TRC: Trc = {
  kind: 'parametric',
  g: 2.4,
  a: 1 / 1.055,
  b: 0.055 / 1.055,
  c: 1 / 12.92,
  d: 0.04045,
  e: 0,
  f: 0,
};

/**
 * The AdobeRGB (1998) transfer curve: a pure power-law gamma of 563/256 =
 * 2.19921875. Forward maps a device code to linear as `code^2.19921875`.
 */
const ADOBE_GAMMA = 563 / 256; // 2.19921875
const ADOBE_TRC: Trc = { kind: 'gamma', gamma: ADOBE_GAMMA };

/**
 * Built-in **sRGB** matrix-shaper profile (D50-adapted colorant matrix +
 * piecewise sRGB TRC). matrix[i][j]: row i of PCS XYZ, column j of device RGB
 * (column 0 = rXYZ, 1 = gXYZ, 2 = bXYZ).
 */
export const SRGB_PROFILE: MatrixShaperProfile = {
  matrix: [
    [0.436026, 0.385098, 0.143088],
    [0.222478, 0.716899, 0.060623],
    [0.013926, 0.097091, 0.714172],
  ],
  trc: [SRGB_TRC, SRGB_TRC, SRGB_TRC],
};

/**
 * Built-in **AdobeRGB (1998)** matrix-shaper profile (D50-adapted colorant matrix
 * + gamma-2.19921875 TRC). matrix layout as for SRGB_PROFILE.
 */
export const ADOBE_RGB_PROFILE: MatrixShaperProfile = {
  matrix: [
    [0.60972, 0.205262, 0.14923],
    [0.311103, 0.625671, 0.063226],
    [0.019473, 0.060884, 0.74483],
  ],
  trc: [ADOBE_TRC, ADOBE_TRC, ADOBE_TRC],
};
