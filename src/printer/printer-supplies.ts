/**
 * Printer marker (ink/toner) supply model + marker-* attribute builder.
 *
 * Every real IPP/AirPrint printer advertises its consumable supply levels via
 * the `marker-*` Printer Description attributes (RFC 8011 §5.4.31–§5.4.36 and
 * PWG 5100.12 §6.x). A supply gauge is what lets a client display the familiar
 * ink/toner level bars after a Get-Printer-Attributes.
 *
 * THE PARALLEL-ARRAY RULE (RFC 8011 §5.4.31): every `marker-*` attribute is a
 * 1setOf with the SAME number of values, in the SAME order. Index i across
 * marker-names / marker-types / marker-colors / marker-levels /
 * marker-low-levels / marker-high-levels / marker-units all describe ONE
 * supply. They must therefore stay length- and order-consistent.
 *
 * marker-levels sentinels (RFC 8011 §5.4.32):
 *   -1 = level unknown
 *   -2 = level unknown but the marker is known to be present
 * otherwise the value is a percentage 0–100 (relative to marker-high-levels,
 * which is conventionally 100 — a full marker).
 *
 * This emulator advertises color (`print-color-mode-supported` includes
 * `color`), so it models a four-supply CMYK ink set to match its own
 * self-description. The levels are static-but-believable; the mutable
 * `PrinterSupplies` state is kept so levels could later be decremented per page
 * without changing the attribute-building shape.
 */

import {
  type IppAttribute,
  integersAttr,
  keywordAttr,
  namesWithoutLangAttr,
  textWithoutLangAttr,
} from '../ipp/attribute.js';

/** A single consumable supply (one CMYK ink cartridge here). */
export interface MarkerSupply {
  /** `marker-names` value — human label, e.g. "Cyan Ink". */
  name: string;
  /**
   * `marker-types` value — a PWG 5100.12 supply-type keyword, e.g.
   * `ink-cartridge` / `toner`.
   */
  type: string;
  /**
   * `marker-colors` value — an `#RRGGBB` sRGB hex string (RFC 8011 §5.4.33
   * permits the `#`-prefixed hex form) or a color keyword.
   */
  color: string;
  /** `marker-levels` value — 0–100 percent, or -1/-2 sentinel. */
  level: number;
  /** `marker-low-levels` value — the low-water threshold (conventionally 10). */
  low: number;
  /** `marker-high-levels` value — the "full" mark (conventionally 100). */
  high: number;
}

/**
 * Mutable supply state. Static-but-believable starting levels (Cyan 60,
 * Magenta 45, Yellow 90, Black 80); held as a small model so a future change
 * can decrement `level` per page without touching the attribute layer.
 */
export class PrinterSupplies {
  readonly markers: MarkerSupply[];

  constructor(markers?: MarkerSupply[]) {
    this.markers = markers ?? DEFAULT_CMYK_MARKERS.map((m) => ({ ...m }));
  }
}

/**
 * Default four-supply CMYK ink set. Order is the conventional C, M, Y, K — the
 * same order every parallel marker-* array follows.
 */
export const DEFAULT_CMYK_MARKERS: readonly MarkerSupply[] = [
  { name: 'Cyan Ink', type: 'ink-cartridge', color: '#00FFFF', level: 60, low: 10, high: 100 },
  { name: 'Magenta Ink', type: 'ink-cartridge', color: '#FF00FF', level: 45, low: 10, high: 100 },
  { name: 'Yellow Ink', type: 'ink-cartridge', color: '#FFFF00', level: 90, low: 10, high: 100 },
  { name: 'Black Ink', type: 'ink-cartridge', color: '#000000', level: 80, low: 10, high: 100 },
] as const;

/** Default supply state for the emulated printer (CMYK ink). */
export const DEFAULT_SUPPLIES = new PrinterSupplies();

/**
 * Build the `marker-*` printer-description attributes from a supply model.
 *
 * Emits seven PARALLEL 1setOf attributes (one value per supply, CMYK order):
 *   - marker-names   (1setOf name)    — RFC 8011 §5.4.31
 *   - marker-types   (1setOf keyword) — RFC 8011 §5.4.34 / PWG 5100.12
 *   - marker-colors  (1setOf name)    — RFC 8011 §5.4.33
 *   - marker-levels  (1setOf integer) — RFC 8011 §5.4.32 (0–100, -1/-2 sentinel)
 *   - marker-low-levels  (1setOf integer) — RFC 8011 §5.4.35
 *   - marker-high-levels (1setOf integer) — RFC 8011 §5.4.36
 *   - marker-units   (1setOf integer) — PWG 5100.12: 100 = "percent" (the
 *     level scale), one entry per supply to keep the parallel-array invariant.
 * plus the scalar:
 *   - marker-message (text) — human-readable supply summary (RFC 8011 §5.4.30).
 */
export function buildMarkerAttributes(
  supplies: PrinterSupplies = DEFAULT_SUPPLIES
): IppAttribute[] {
  const markers = supplies.markers;
  // PWG 5100.12 marker-units value 100 == "percent" — the unit marker-levels,
  // -low-levels and -high-levels are expressed in. One per supply (parallel).
  const PERCENT_UNITS = 100;
  return [
    namesWithoutLangAttr('marker-names', ...markers.map((m) => m.name)),
    keywordAttr('marker-types', ...markers.map((m) => m.type)),
    namesWithoutLangAttr('marker-colors', ...markers.map((m) => m.color)),
    integersAttr('marker-levels', ...markers.map((m) => m.level)),
    integersAttr('marker-low-levels', ...markers.map((m) => m.low)),
    integersAttr('marker-high-levels', ...markers.map((m) => m.high)),
    integersAttr('marker-units', ...markers.map(() => PERCENT_UNITS)),
    textWithoutLangAttr('marker-message', markerMessage(markers)),
  ];
}

/** Human-readable supply summary for `marker-message`. */
function markerMessage(markers: readonly MarkerSupply[]): string {
  return markers.map((m) => `${m.name} ${m.level}%`).join(', ');
}
