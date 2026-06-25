/**
 * Get-Printer-Attributes operation (0x000B) — RFC 8011 §4.2.5. WORKING.
 *
 * Returns successful-ok plus a printer-attributes group describing the
 * emulated printer's identity and capabilities, with live printer-state.
 * The required operation-attributes (charset, natural-language) lead the
 * response per RFC 8010.
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
} from '../constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
} from '../attribute.js';
import {
  operationGroup,
  printerGroup,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import { buildPrinterAttributes } from '../../printer/printer-attributes.js';
import { applyRequestedAttributes } from '../requested-attributes.js';
import type { OperationContext } from '../dispatcher.js';

export function handleGetPrinterAttributes(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const printerAttrs = applyRequestedAttributes(
    request,
    buildPrinterAttributes(
      ctx.identity,
      ctx.printerState(),
      ctx.printerStateReasons?.(),
      ctx.ippsUri,
      ctx.printerUpTime?.()
    )
  );

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
    requestId: request.requestId,
    groups: [
      operationGroup([
        charsetAttr('attributes-charset', DEFAULT_CHARSET),
        naturalLanguageAttr(
          'attributes-natural-language',
          DEFAULT_NATURAL_LANGUAGE
        ),
      ]),
      printerGroup(printerAttrs),
    ],
  };
}
