/**
 * Default IPP Everywhere printer attribute set.
 *
 * The Get-Printer-Attributes response advertises the printer's identity and
 * capabilities (RFC 8011 §5.4, IPP Everywhere PWG 5100.14). This module builds
 * a representative printer-attributes group; printer-state and
 * printer-state-reasons are injected at response time so they always reflect
 * live state (e.g. `stopped` + `paused` while the printer is paused).
 */

import {
  PrinterStates,
  OperationIds,
  JobHoldUntil,
  JOB_HOLD_UNTIL_DEFAULT,
  PrintColorMode,
  PRINT_COLOR_MODE_DEFAULT,
  PrintQuality,
  PRINT_QUALITY_DEFAULT,
  Sides,
  SIDES_DEFAULT,
  OrientationRequested,
  ORIENTATION_REQUESTED_DEFAULT,
  Media,
  MEDIA_DEFAULT,
  type PrinterStateValue,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
} from '../ipp/constants.js';
import {
  type IppAttribute,
  enumAttr,
  enumsAttr,
  booleanAttr,
  keywordAttr,
  uriAttr,
  nameWithoutLangAttr,
  textWithoutLangAttr,
  mimeMediaTypeAttr,
} from '../ipp/attribute.js';
import { ValueTags } from '../ipp/constants.js';
import { JOB_SETTABLE_ATTRIBUTES } from './job.js';

export interface PrinterIdentity {
  name: string;
  uri: string;
  makeAndModel: string;
  /** DNS-SD UUID (printer-uuid / mDNS UUID TXT key). */
  uuid: string;
  /** Physical location string (printer-location / mDNS note TXT key). */
  location: string;
  /**
   * Free-form administrative description (`printer-info`, RFC 8011 §5.4.7). A
   * settable attribute (Set-Printer-Attributes); optional so the default
   * identity can omit it.
   */
  info?: string;
  /**
   * `printer-geo-location` (PWG 5100.13): a `geo:` URI giving the printer's
   * geographic position. Settable; optional (absent in the default identity).
   */
  geoLocation?: string;
  /**
   * `printer-organization` (PWG 5100.13): the owning organization name.
   * Settable; optional (absent in the default identity).
   */
  organization?: string;
}

/**
 * The settable printer-description attributes this emulator honors via
 * Set-Printer-Attributes (RFC 3380 §4.1), advertised in
 * `printer-settable-attributes-supported`. Each maps onto a PrinterIdentity
 * field that Get-Printer-Attributes reflects. Kept here so the writable set and
 * its advertisement stay in one place.
 */
export const PRINTER_SETTABLE_ATTRIBUTES = [
  'printer-name',
  'printer-info',
  'printer-location',
  'printer-geo-location',
  'printer-organization',
] as const;

export const DEFAULT_IDENTITY: PrinterIdentity = {
  name: 'Emulated IPP Everywhere Printer',
  uri: 'ipp://localhost:631/ipp/print',
  makeAndModel: 'printer-emulator 0.1.0',
  uuid: '564e4d57-0000-1000-8000-001122334455',
  location: 'Emulator',
};

/**
 * AirPrint URF (Universal Raster Format) capability string. Declared here so
 * Get-Printer-Attributes and the mDNS TXT record advertise the same raster
 * capabilities. The token list is an AirPrint-plausible IPP-Everywhere set.
 */
export const URF_SUPPORTED =
  'CP1,DM3,IS1,MT1-3-4-5-8,OB10,PQ4,RS200-300,SRGB24,V1.4,W8,DEVW8';

/** Document formats this emulated printer claims to accept. */
export const SUPPORTED_FORMATS = [
  'application/pdf',
  'application/postscript',
  'image/pwg-raster',
  'image/urf',
  'image/jpeg',
  'application/octet-stream',
];

/**
 * Build the printer-attributes group reported by Get-Printer-Attributes.
 * `state` and `stateReasons` are supplied by the caller so the response is
 * always current — `stateReasons` defaults to `['none']` (RFC 8011 sentinel
 * for "no reasons") and is set to `['paused']` while the printer is paused.
 */
export function buildPrinterAttributes(
  identity: PrinterIdentity,
  state: PrinterStateValue = PrinterStates.IDLE,
  stateReasons: string[] = ['none'],
  /**
   * Optional `ipps://…` URI. When supplied (TLS enabled), it's added to
   * printer-uri-supported (now 1setOf) alongside the plaintext `ipp://` URI,
   * with the parallel `uri-security-supported`/`uri-authentication-supported`
   * values gaining a `tls` entry. When omitted, the attribute set is byte-for-
   * byte identical to the plaintext-only printer.
   */
  ippsUri?: string
): IppAttribute[] {
  const reasons = stateReasons.length > 0 ? stateReasons : ['none'];
  const version = `${IPP_VERSION_MAJOR}.${IPP_VERSION_MINOR}`;
  // uri-security-supported / uri-authentication-supported are positional 1setOf
  // attributes — value N describes URI N in printer-uri-supported (RFC 8011
  // §5.4.2). Keep them in lockstep with the URI list.
  const uriSupported = ippsUri
    ? { name: 'printer-uri-supported', values: [identity.uri, ippsUri].map((u) => ({ tag: ValueTags.URI, value: u })) }
    : uriAttr('printer-uri-supported', identity.uri);
  const uriSecurity = ippsUri
    ? keywordAttr('uri-security-supported', 'none', 'tls')
    : keywordAttr('uri-security-supported', 'none');
  const uriAuth = ippsUri
    ? keywordAttr('uri-authentication-supported', 'requesting-user-name', 'requesting-user-name')
    : keywordAttr('uri-authentication-supported', 'requesting-user-name');
  return [
    uriSupported,
    uriSecurity,
    uriAuth,
    nameWithoutLangAttr('printer-name', identity.name),
    textWithoutLangAttr('printer-make-and-model', identity.makeAndModel),
    textWithoutLangAttr('printer-location', identity.location),
    // printer-info / printer-geo-location / printer-organization are settable
    // (Set-Printer-Attributes, RFC 3380 §4.1) — emitted only once given a value
    // so the default attribute set is unchanged until a client writes one.
    ...(identity.info !== undefined
      ? [textWithoutLangAttr('printer-info', identity.info)]
      : []),
    ...(identity.geoLocation !== undefined
      ? [uriAttr('printer-geo-location', identity.geoLocation)]
      : []),
    ...(identity.organization !== undefined
      ? [textWithoutLangAttr('printer-organization', identity.organization)]
      : []),
    uriAttr('printer-uuid', `urn:uuid:${identity.uuid}`),
    enumAttr('printer-state', state),
    keywordAttr('printer-state-reasons', ...reasons),
    keywordAttr(
      'ipp-versions-supported',
      version === '2.0' ? '2.0' : version,
      '1.1'
    ),
    // operations-supported (1setOf enum) — every operation the dispatcher
    // handles, including the multi-document Create-Job/Send-Document/Close-Job
    // lifecycle.
    {
      name: 'operations-supported',
      values: [
        OperationIds.PRINT_JOB,
        OperationIds.VALIDATE_JOB,
        OperationIds.CREATE_JOB,
        OperationIds.SEND_DOCUMENT,
        OperationIds.CANCEL_JOB,
        OperationIds.PURGE_JOBS,
        OperationIds.CANCEL_MY_JOBS,
        OperationIds.GET_JOB_ATTRIBUTES,
        OperationIds.GET_JOBS,
        OperationIds.GET_PRINTER_ATTRIBUTES,
        OperationIds.HOLD_JOB,
        OperationIds.RELEASE_JOB,
        OperationIds.RESTART_JOB,
        OperationIds.PAUSE_PRINTER,
        OperationIds.RESUME_PRINTER,
        OperationIds.CLOSE_JOB,
        OperationIds.IDENTIFY_PRINTER,
        OperationIds.SET_PRINTER_ATTRIBUTES,
        OperationIds.SET_JOB_ATTRIBUTES,
      ].map((op) => ({ tag: ValueTags.ENUM, value: op })),
    },
    // Set-Printer-Attributes / Set-Job-Attributes (RFC 3380) writable sets: the
    // printer- and job-description attributes a client may modify. NOTE: a real
    // IPP host gates these writes behind operator/admin operation policy; this
    // emulator has no auth layer, so it applies them unconditionally (see README).
    keywordAttr(
      'printer-settable-attributes-supported',
      ...PRINTER_SETTABLE_ATTRIBUTES
    ),
    keywordAttr(
      'job-settable-attributes-supported',
      ...JOB_SETTABLE_ATTRIBUTES
    ),
    // Identify-Printer (0x003C) capability advertisement (RFC 3998 / PWG):
    // which identify actions this emulator accepts, and which it uses by
    // default when the client sends none.
    keywordAttr('identify-actions-supported', 'flash', 'sound'),
    keywordAttr('identify-actions-default', 'flash'),
    keywordAttr('charset-configured', 'utf-8'),
    keywordAttr('charset-supported', 'utf-8'),
    keywordAttr('natural-language-configured', 'en'),
    keywordAttr('generated-natural-language-supported', 'en'),
    mimeMediaTypeAttr('document-format-default', 'application/octet-stream'),
    mimeMediaTypeAttr('document-format-supported', ...SUPPORTED_FORMATS),
    booleanAttr('printer-is-accepting-jobs', true),
    keywordAttr('pdl-override-supported', 'attempted'),
    keywordAttr('compression-supported', 'none'),
    // Common print Job Template capabilities (RFC 8011 §5.2 / PWG 5100.13): the
    // value set this emulator accepts on Print-Job/Create-Job/Set-Job-Attributes
    // plus the default applied when a client omits each. `print-color-mode`
    // actually changes output — `monochrome` forces a grayscale raster.
    keywordAttr('media-supported', Media.ISO_A4, Media.NA_LETTER),
    keywordAttr('media-default', MEDIA_DEFAULT),
    keywordAttr(
      'sides-supported',
      Sides.ONE_SIDED,
      Sides.TWO_SIDED_LONG_EDGE,
      Sides.TWO_SIDED_SHORT_EDGE
    ),
    keywordAttr('sides-default', SIDES_DEFAULT),
    keywordAttr(
      'print-color-mode-supported',
      PrintColorMode.AUTO,
      PrintColorMode.COLOR,
      PrintColorMode.MONOCHROME
    ),
    keywordAttr('print-color-mode-default', PRINT_COLOR_MODE_DEFAULT),
    enumsAttr(
      'print-quality-supported',
      PrintQuality.DRAFT,
      PrintQuality.NORMAL,
      PrintQuality.HIGH
    ),
    enumAttr('print-quality-default', PRINT_QUALITY_DEFAULT),
    enumsAttr(
      'orientation-requested-supported',
      OrientationRequested.PORTRAIT,
      OrientationRequested.LANDSCAPE,
      OrientationRequested.REVERSE_LANDSCAPE,
      OrientationRequested.REVERSE_PORTRAIT
    ),
    enumAttr('orientation-requested-default', ORIENTATION_REQUESTED_DEFAULT),
    keywordAttr('urf-supported', ...URF_SUPPORTED.split(',')),
    // job-hold-until (RFC 8011 §5.2.2): the keyword values this emulator accepts
    // and the default applied when a client omits it (`no-hold` — run normally).
    // The named time values are held until an explicit Release-Job; the emulator
    // has no wall-clock release policy (see README).
    keywordAttr(
      'job-hold-until-supported',
      JobHoldUntil.NO_HOLD,
      JobHoldUntil.INDEFINITE,
      JobHoldUntil.DAY_TIME,
      JobHoldUntil.EVENING,
      JobHoldUntil.NIGHT,
      JobHoldUntil.WEEKEND,
      JobHoldUntil.SECOND_SHIFT,
      JobHoldUntil.THIRD_SHIFT
    ),
    keywordAttr('job-hold-until-default', JOB_HOLD_UNTIL_DEFAULT),
  ];
}
