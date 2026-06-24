/**
 * IPP Protocol Constants
 *
 * Binary encoding per RFC 8010 and the model/semantics per RFC 8011.
 * Declared as `as const` objects so the literal values are usable as both
 * runtime tables and TypeScript types.
 */

// ── IPP version (major.minor, one byte each) ──────────────────────────────
export const IPP_VERSION_MAJOR = 0x02;
export const IPP_VERSION_MINOR = 0x00; // IPP 2.0

// ── Operation ids (request) — RFC 8011 §4.4 ───────────────────────────────
export const OperationIds = {
  PRINT_JOB: 0x0002,
  VALIDATE_JOB: 0x0004,
  CREATE_JOB: 0x0005,
  SEND_DOCUMENT: 0x0006,
  CANCEL_JOB: 0x0008,
  GET_JOB_ATTRIBUTES: 0x0009,
  GET_JOBS: 0x000a,
  GET_PRINTER_ATTRIBUTES: 0x000b,
  HOLD_JOB: 0x000c,
  RELEASE_JOB: 0x000d,
  RESTART_JOB: 0x000e,
  PAUSE_PRINTER: 0x0010,
  RESUME_PRINTER: 0x0011,
  PURGE_JOBS: 0x0012,
  SET_PRINTER_ATTRIBUTES: 0x0013,
  SET_JOB_ATTRIBUTES: 0x0014,
  CANCEL_MY_JOBS: 0x0039,
  CLOSE_JOB: 0x003b,
  IDENTIFY_PRINTER: 0x003c,
} as const;

export type OperationId = (typeof OperationIds)[keyof typeof OperationIds];

// ── Status codes (response) — RFC 8011 §13 ────────────────────────────────
export const StatusCodes = {
  SUCCESSFUL_OK: 0x0000,
  CLIENT_ERROR_BAD_REQUEST: 0x0400,
  CLIENT_ERROR_NOT_POSSIBLE: 0x0405,
  CLIENT_ERROR_NOT_FOUND: 0x0406,
  SERVER_ERROR_OPERATION_NOT_SUPPORTED: 0x0501,
} as const;

export type StatusCode = (typeof StatusCodes)[keyof typeof StatusCodes];

// ── Delimiter tags — RFC 8010 §3.5.1 ──────────────────────────────────────
export const DelimiterTags = {
  OPERATION_ATTRIBUTES: 0x01,
  JOB_ATTRIBUTES: 0x02,
  END_OF_ATTRIBUTES: 0x03,
  PRINTER_ATTRIBUTES: 0x04,
  UNSUPPORTED_ATTRIBUTES: 0x05,
} as const;

export type DelimiterTag = (typeof DelimiterTags)[keyof typeof DelimiterTags];

// ── Value tags — RFC 8010 §3.5.2 ──────────────────────────────────────────
export const ValueTags = {
  // out-of-band
  UNSUPPORTED: 0x10,
  NO_VALUE: 0x13,
  // integer family
  INTEGER: 0x21,
  BOOLEAN: 0x22,
  ENUM: 0x23,
  // octet-string family
  OCTET_STRING: 0x30,
  DATE_TIME: 0x31,
  RESOLUTION: 0x32,
  RANGE_OF_INTEGER: 0x33,
  TEXT_WITH_LANG: 0x35,
  NAME_WITH_LANG: 0x36,
  // character-string family
  TEXT_WITHOUT_LANG: 0x41,
  NAME_WITHOUT_LANG: 0x42,
  KEYWORD: 0x44,
  URI: 0x45,
  URI_SCHEME: 0x46,
  CHARSET: 0x47,
  NATURAL_LANGUAGE: 0x48,
  MIME_MEDIA_TYPE: 0x49,
} as const;

export type ValueTag = (typeof ValueTags)[keyof typeof ValueTags];

// ── Printer states — RFC 8011 §5.4.11 ─────────────────────────────────────
export const PrinterStates = {
  IDLE: 3,
  PROCESSING: 4,
  STOPPED: 5,
} as const;

export type PrinterStateValue =
  (typeof PrinterStates)[keyof typeof PrinterStates];

// ── Job states — RFC 8011 §5.3.7 ──────────────────────────────────────────
export const JobStates = {
  PENDING: 3,
  PENDING_HELD: 4,
  PROCESSING: 5,
  PROCESSING_STOPPED: 6,
  CANCELED: 7,
  ABORTED: 8,
  COMPLETED: 9,
} as const;

export type JobStateValue = (typeof JobStates)[keyof typeof JobStates];

// ── job-hold-until keyword values — RFC 8011 §5.2.2 ───────────────────────
/**
 * Standard `job-hold-until` (type2 keyword | name) values. `no-hold` means the
 * job is NOT held and runs normally; every other value holds the job as
 * `pending-held`. The named time values (`day-time` … `third-shift`) are wall-
 * clock release windows in a full implementation; this emulator has no
 * wall-clock release policy, so they map to held-until-explicit-Release-Job
 * (see hold-until.ts). Advertised via `job-hold-until-supported`.
 */
export const JobHoldUntil = {
  NO_HOLD: 'no-hold',
  INDEFINITE: 'indefinite',
  DAY_TIME: 'day-time',
  EVENING: 'evening',
  NIGHT: 'night',
  WEEKEND: 'weekend',
  SECOND_SHIFT: 'second-shift',
  THIRD_SHIFT: 'third-shift',
} as const;

export type JobHoldUntilValue =
  (typeof JobHoldUntil)[keyof typeof JobHoldUntil];

/** Default `job-hold-until` when a client omits it: do not hold. */
export const JOB_HOLD_UNTIL_DEFAULT = JobHoldUntil.NO_HOLD;

// ── print-color-mode keyword values — PWG 5100.13 §6.6 ────────────────────
/**
 * `print-color-mode` (type2 keyword) tells the printer whether to render in
 * color, force grayscale, or decide automatically. `monochrome` forces a
 * grayscale raster even for a color source (the emulator converts color pixels
 * to luma — see raster-render.ts); `color`/`auto` keep the source's own color.
 * Advertised via `print-color-mode-supported`; default is `auto`.
 */
export const PrintColorMode = {
  AUTO: 'auto',
  COLOR: 'color',
  MONOCHROME: 'monochrome',
} as const;

export type PrintColorModeValue =
  (typeof PrintColorMode)[keyof typeof PrintColorMode];

/** Default `print-color-mode` when a client omits it: decide automatically. */
export const PRINT_COLOR_MODE_DEFAULT = PrintColorMode.AUTO;

// ── print-quality enum values — RFC 8011 §5.2.13 ──────────────────────────
/** `print-quality` (type2 enum): draft (3), normal (4), high (5). */
export const PrintQuality = {
  DRAFT: 3,
  NORMAL: 4,
  HIGH: 5,
} as const;

export type PrintQualityValue =
  (typeof PrintQuality)[keyof typeof PrintQuality];

/** Default `print-quality` when a client omits it: normal. */
export const PRINT_QUALITY_DEFAULT = PrintQuality.NORMAL;

// ── sides keyword values — RFC 8011 §5.2.8 ────────────────────────────────
/** `sides` (type2 keyword): single- or double-sided binding edges. */
export const Sides = {
  ONE_SIDED: 'one-sided',
  TWO_SIDED_LONG_EDGE: 'two-sided-long-edge',
  TWO_SIDED_SHORT_EDGE: 'two-sided-short-edge',
} as const;

export type SidesValue = (typeof Sides)[keyof typeof Sides];

/** Default `sides` when a client omits it: one-sided. */
export const SIDES_DEFAULT = Sides.ONE_SIDED;

// ── orientation-requested enum values — RFC 8011 §5.2.10 ──────────────────
/**
 * `orientation-requested` (type2 enum): portrait (3), landscape (4),
 * reverse-landscape (5), reverse-portrait (6).
 */
export const OrientationRequested = {
  PORTRAIT: 3,
  LANDSCAPE: 4,
  REVERSE_LANDSCAPE: 5,
  REVERSE_PORTRAIT: 6,
} as const;

export type OrientationRequestedValue =
  (typeof OrientationRequested)[keyof typeof OrientationRequested];

/** Default `orientation-requested` when a client omits it: portrait. */
export const ORIENTATION_REQUESTED_DEFAULT = OrientationRequested.PORTRAIT;

// ── number-up integer values — RFC 8011 §5.2.15 ──────────────────────────
/**
 * The `number-up` (integer ≥ 1) grid values this emulator advertises in
 * `number-up-supported`: 1, 2, 4, 6, 9, 16. `number-up` tiles N consecutive
 * source pages onto one output sheet in a grid (see documents/raster-render.ts).
 * A client may request any positive integer; an out-of-set value is still
 * honored by the render path (it just isn't advertised), and a value < 1 / absent
 * is treated as 1 (one page per sheet — the existing behavior).
 */
export const NUMBER_UP_SUPPORTED = [1, 2, 4, 6, 9, 16] as const;

/** Default `number-up` when a client omits it: 1 (one source page per sheet). */
export const NUMBER_UP_DEFAULT = 1;

// ── media keyword values (PWG self-describing media size names) ────────────
/**
 * The two `media` (type2 keyword) sizes this emulator advertises. PWG 5101.1
 * self-describing names; ISO A4 is the default, US Letter the alternative.
 */
export const Media = {
  ISO_A4: 'iso_a4_210x297mm',
  NA_LETTER: 'na_letter_8.5x11in',
} as const;

export type MediaValue = (typeof Media)[keyof typeof Media];

/** Default `media` when a client omits it: ISO A4 (matches `media-default`). */
export const MEDIA_DEFAULT = Media.ISO_A4;

// ── Charset / natural language defaults ───────────────────────────────────
export const DEFAULT_CHARSET = 'utf-8';
export const DEFAULT_NATURAL_LANGUAGE = 'en';

// ── HTTP transport ────────────────────────────────────────────────────────
export const IPP_CONTENT_TYPE = 'application/ipp';

/**
 * Default IPP port. 631 is the IANA-assigned IPP port (used by CUPS and
 * AirPrint), but binding it requires elevated privileges on most systems.
 * The CLI/demo defaults to DEMO_PORT to avoid sudo; override with PORT.
 */
export const DEFAULT_PORT = 631;
export const DEMO_PORT = 6310;

/**
 * Default IPPS (IPP-over-TLS) port. 631 is shared with plaintext IPP in the
 * real world, but the emulator runs both servers in one process, so IPPS gets
 * its own port. Like DEFAULT_PORT, the canonical value is privileged; the CLI
 * defaults to DEFAULT_TLS_PORT (6311) to avoid sudo. Override with TLS_PORT.
 */
export const DEFAULT_TLS_PORT = 6311;
