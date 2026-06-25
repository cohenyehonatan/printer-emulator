/**
 * Set-Printer-Attributes operation (0x0013) — RFC 3380 §4.1. WORKING.
 *
 * Reads the printer-attributes group from the request and applies the SETTABLE
 * printer-description attributes as overrides on the live printer identity, so
 * a subsequent Get-Printer-Attributes reflects the new values. The settable set
 * (advertised as `printer-settable-attributes-supported`) is:
 *   - `printer-name`         (name)        → identity.name
 *   - `printer-info`         (text)        → identity.info
 *   - `printer-location`     (text)        → identity.location
 *   - `printer-geo-location` (uri, geo:)   → identity.geoLocation
 *   - `printer-organization` (text)        → identity.organization
 *
 * Unsettable / unknown attributes do NOT fail the whole operation (RFC 3380 is
 * "best-effort apply"): the recognized ones are applied and any others are
 * returned in an `unsupported-attributes` group (each as the out-of-band
 * `unsupported` value), with an overall `successful-ok`. The override is applied
 * via `ctx.setPrinterAttributes` when present (IppPrinter mutates its identity);
 * bare unit-test contexts without that hook fall back to mutating `ctx.identity`
 * directly. Never throws.
 *
 * NO-AUTH CAVEAT: a real IPP host gates Set-Printer-Attributes behind
 * operator/admin operation policy. This emulator has no authentication layer, so
 * it applies the writes unconditionally (see README).
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  DelimiterTags,
  ValueTags,
} from '../constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  firstString,
  type IppAttribute,
} from '../attribute.js';
import {
  operationGroup,
  printerGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import {
  buildPrinterAttributes,
  PRINTER_SETTABLE_ATTRIBUTES,
  type PrinterIdentity,
} from '../../printer/printer-attributes.js';
import type { OperationContext } from '../dispatcher.js';

/** Map a settable printer attribute name to the PrinterIdentity field it sets. */
const ATTR_TO_FIELD: Record<string, keyof PrinterIdentity> = {
  'printer-name': 'name',
  'printer-info': 'info',
  'printer-location': 'location',
  'printer-geo-location': 'geoLocation',
  'printer-organization': 'organization',
};

const SETTABLE = new Set<string>(PRINTER_SETTABLE_ATTRIBUTES);

export function handleSetPrinterAttributes(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  // The new values arrive in the printer-attributes group (RFC 3380 §4.1).
  const printerAttrs = getGroupAttributes(
    request,
    DelimiterTags.PRINTER_ATTRIBUTES
  );

  const overrides: Partial<PrinterIdentity> = {};
  const unsupported: IppAttribute[] = [];

  for (const attr of printerAttrs) {
    if (SETTABLE.has(attr.name)) {
      const value = firstString(attr);
      if (value !== undefined) {
        overrides[ATTR_TO_FIELD[attr.name]] = value;
      }
    } else {
      // Unsettable/unknown: surface it as unsupported rather than failing the op.
      unsupported.push({
        name: attr.name,
        values: [{ tag: ValueTags.UNSUPPORTED, value: '' }],
      });
    }
  }

  // Apply the overrides. Prefer the printer's hook (mutates the live identity);
  // fall back to mutating ctx.identity directly for bare unit-test contexts.
  if (ctx.setPrinterAttributes) {
    ctx.setPrinterAttributes(overrides);
  } else {
    applyToIdentity(ctx.identity, overrides);
  }

  // Echo the now-current printer attributes so the client sees the applied set.
  const groups = [
    operationGroup([
      charsetAttr('attributes-charset', DEFAULT_CHARSET),
      naturalLanguageAttr('attributes-natural-language', DEFAULT_NATURAL_LANGUAGE),
    ]),
  ];
  if (unsupported.length > 0) {
    groups.push({
      tag: DelimiterTags.UNSUPPORTED_ATTRIBUTES,
      attributes: unsupported,
    });
  }
  groups.push(
    printerGroup(
      buildPrinterAttributes(
        ctx.identity,
        ctx.printerState(),
        ctx.printerStateReasons?.(),
        ctx.ippsUri,
        undefined,
        undefined,
        ctx.isAcceptingJobs?.() ?? true
      )
    )
  );

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
    requestId: request.requestId,
    groups,
  };
}

/** Fallback: apply settable overrides straight onto a PrinterIdentity object. */
function applyToIdentity(
  identity: PrinterIdentity,
  overrides: Partial<PrinterIdentity>
): void {
  if (overrides.name !== undefined) identity.name = overrides.name;
  if (overrides.info !== undefined) identity.info = overrides.info;
  if (overrides.location !== undefined) identity.location = overrides.location;
  if (overrides.geoLocation !== undefined) {
    identity.geoLocation = overrides.geoLocation;
  }
  if (overrides.organization !== undefined) {
    identity.organization = overrides.organization;
  }
}
