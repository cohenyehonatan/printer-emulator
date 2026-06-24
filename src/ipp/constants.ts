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
