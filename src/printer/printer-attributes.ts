/**
 * Default IPP Everywhere printer attribute set.
 *
 * The Get-Printer-Attributes response advertises the printer's identity and
 * capabilities (RFC 8011 §5.4, IPP Everywhere PWG 5100.14). This module builds
 * a representative printer-attributes group; printer-state is injected at
 * response time so it always reflects live state.
 */

import {
  PrinterStates,
  OperationIds,
  type PrinterStateValue,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
} from '../ipp/constants.js';
import {
  type IppAttribute,
  enumAttr,
  booleanAttr,
  keywordAttr,
  uriAttr,
  nameWithoutLangAttr,
  textWithoutLangAttr,
  mimeMediaTypeAttr,
} from '../ipp/attribute.js';
import { ValueTags } from '../ipp/constants.js';

export interface PrinterIdentity {
  name: string;
  uri: string;
  makeAndModel: string;
  /** DNS-SD UUID (printer-uuid / mDNS UUID TXT key). */
  uuid: string;
  /** Physical location string (printer-location / mDNS note TXT key). */
  location: string;
}

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
 * `state` is supplied by the caller so the response is always current.
 */
export function buildPrinterAttributes(
  identity: PrinterIdentity,
  state: PrinterStateValue = PrinterStates.IDLE
): IppAttribute[] {
  const version = `${IPP_VERSION_MAJOR}.${IPP_VERSION_MINOR}`;
  return [
    uriAttr('printer-uri-supported', identity.uri),
    keywordAttr('uri-security-supported', 'none'),
    keywordAttr('uri-authentication-supported', 'requesting-user-name'),
    nameWithoutLangAttr('printer-name', identity.name),
    textWithoutLangAttr('printer-make-and-model', identity.makeAndModel),
    textWithoutLangAttr('printer-location', identity.location),
    uriAttr('printer-uuid', `urn:uuid:${identity.uuid}`),
    enumAttr('printer-state', state),
    keywordAttr('printer-state-reasons', 'none'),
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
        OperationIds.GET_JOB_ATTRIBUTES,
        OperationIds.GET_JOBS,
        OperationIds.GET_PRINTER_ATTRIBUTES,
        OperationIds.HOLD_JOB,
        OperationIds.RELEASE_JOB,
        OperationIds.CLOSE_JOB,
      ].map((op) => ({ tag: ValueTags.ENUM, value: op })),
    },
    keywordAttr('charset-configured', 'utf-8'),
    keywordAttr('charset-supported', 'utf-8'),
    keywordAttr('natural-language-configured', 'en'),
    keywordAttr('generated-natural-language-supported', 'en'),
    mimeMediaTypeAttr('document-format-default', 'application/octet-stream'),
    mimeMediaTypeAttr('document-format-supported', ...SUPPORTED_FORMATS),
    booleanAttr('printer-is-accepting-jobs', true),
    keywordAttr('pdl-override-supported', 'attempted'),
    keywordAttr('compression-supported', 'none'),
    keywordAttr('media-default', 'iso_a4_210x297mm'),
    keywordAttr('media-supported', 'iso_a4_210x297mm', 'na_letter_8.5x11in'),
    keywordAttr('sides-supported', 'one-sided', 'two-sided-long-edge'),
    keywordAttr('print-color-mode-supported', 'monochrome', 'color'),
    keywordAttr('urf-supported', ...URF_SUPPORTED.split(',')),
  ];
}
