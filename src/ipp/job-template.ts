/**
 * Common print Job Template attributes — parse + normalize.
 *
 * Beyond `copies`/`job-hold-until`, real IPP clients (CUPS, AirPrint, ipptool)
 * routinely send a handful of Job Template attributes that select how a job is
 * rendered: `print-color-mode`, `print-quality`, `sides`,
 * `orientation-requested`, and `media` (RFC 8011 §5.2 / PWG 5100.13). This
 * module reads them from the job-attributes group of Print-Job/Create-Job (and
 * the same group Set-Job-Attributes carries), validates each against the value
 * set this emulator advertises, and clamps/ignores anything unknown to the
 * documented default. Nothing here throws on malformed protocol input.
 *
 * The normalized values land on the Job (see printer/job.ts) and are echoed by
 * Get-Job-Attributes / Get-Jobs only once a client supplied them, mirroring how
 * `copies` is handled.
 */

import {
  PrintColorMode,
  PrintQuality,
  Sides,
  OrientationRequested,
  Media,
  type PrintColorModeValue,
  type PrintQualityValue,
  type SidesValue,
  type OrientationRequestedValue,
  type MediaValue,
} from './constants.js';
import { firstString, firstNumber, findAttr, type IppAttribute } from './attribute.js';

/** The advertised `print-color-mode` keyword set (color/monochrome/auto). */
const COLOR_MODES = new Set<string>(Object.values(PrintColorMode));
/** The advertised `print-quality` enum set (draft/normal/high). */
const QUALITIES = new Set<number>(Object.values(PrintQuality));
/** The advertised `sides` keyword set. */
const SIDES_VALUES = new Set<string>(Object.values(Sides));
/** The advertised `orientation-requested` enum set. */
const ORIENTATIONS = new Set<number>(Object.values(OrientationRequested));
/** The advertised `media` keyword set. */
const MEDIA_VALUES = new Set<string>(Object.values(Media));

/**
 * Normalize a `print-color-mode` keyword. Returns the value when it is one of
 * `color`/`monochrome`/`auto`; otherwise undefined (caller leaves the field
 * unset → the printer default applies).
 */
export function normalizeColorMode(
  value: string | undefined
): PrintColorModeValue | undefined {
  return value !== undefined && COLOR_MODES.has(value)
    ? (value as PrintColorModeValue)
    : undefined;
}

/** Normalize a `print-quality` enum (3/4/5); undefined when out of range. */
export function normalizeQuality(
  value: number | undefined
): PrintQualityValue | undefined {
  return value !== undefined && QUALITIES.has(value)
    ? (value as PrintQualityValue)
    : undefined;
}

/** Normalize a `sides` keyword; undefined when not an advertised value. */
export function normalizeSides(
  value: string | undefined
): SidesValue | undefined {
  return value !== undefined && SIDES_VALUES.has(value)
    ? (value as SidesValue)
    : undefined;
}

/** Normalize an `orientation-requested` enum (3–6); undefined otherwise. */
export function normalizeOrientation(
  value: number | undefined
): OrientationRequestedValue | undefined {
  return value !== undefined && ORIENTATIONS.has(value)
    ? (value as OrientationRequestedValue)
    : undefined;
}

/** Normalize a `media` keyword; undefined when not an advertised size. */
export function normalizeMedia(
  value: string | undefined
): MediaValue | undefined {
  return value !== undefined && MEDIA_VALUES.has(value)
    ? (value as MediaValue)
    : undefined;
}

/** A parsed set of print Job Template attributes (undefined = client omitted). */
export interface JobTemplate {
  printColorMode?: PrintColorModeValue;
  printQuality?: PrintQualityValue;
  sides?: SidesValue;
  orientation?: OrientationRequestedValue;
  media?: MediaValue;
}

/**
 * Read the print Job Template attributes from a request's job-attributes group.
 * Each is normalized against the advertised value set; an unknown/invalid value
 * yields undefined for that key (the Job then keeps its default). Never throws.
 */
export function readJobTemplate(jobAttrs: IppAttribute[]): JobTemplate {
  return {
    printColorMode: normalizeColorMode(
      firstString(findAttr(jobAttrs, 'print-color-mode'))
    ),
    printQuality: normalizeQuality(
      firstNumber(findAttr(jobAttrs, 'print-quality'))
    ),
    sides: normalizeSides(firstString(findAttr(jobAttrs, 'sides'))),
    orientation: normalizeOrientation(
      firstNumber(findAttr(jobAttrs, 'orientation-requested'))
    ),
    media: normalizeMedia(firstString(findAttr(jobAttrs, 'media'))),
  };
}
