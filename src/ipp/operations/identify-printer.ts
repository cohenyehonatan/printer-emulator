/**
 * Identify-Printer operation (0x003C) — RFC 3998 / PWG 5100.13. WORKING.
 *
 * Asks the printer to make itself physically identifiable — flash a light,
 * sound a tone, or show a message on its display — so a user can locate it.
 * Parses the optional `identify-actions` operation attribute (1setOf keyword:
 * `flash` / `sound` / `display`) and the optional `message` text; when no
 * action is supplied the printer's `identify-actions-default` (`flash`) is
 * used. Because this is an emulator there is no physical device, so the action
 * is LOGGED via the Logger (e.g. "IDENTIFY: flash") rather than performed.
 *
 * Returns successful-ok with the standard operation attributes. Never throws —
 * malformed/absent identify-actions falls back to the default, and the request
 * still succeeds with or without identify-actions.
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  DelimiterTags,
} from '../constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  allStrings,
  firstString,
  findAttr,
} from '../attribute.js';
import {
  operationGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import { Logger } from '../../logging/logger.js';
import type { OperationContext } from '../dispatcher.js';

/** Identify actions this emulator recognizes (others are logged verbatim). */
const DEFAULT_ACTION = 'flash';

const logger = new Logger('IDENTIFY');

export function handleIdentifyPrinter(
  request: IppRequest,
  _ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );

  // identify-actions is a 1setOf keyword; default to the printer's
  // identify-actions-default when the client sends none.
  const actions = allStrings(findAttr(opAttrs, 'identify-actions'));
  const effective = actions.length > 0 ? actions : [DEFAULT_ACTION];
  const message = firstString(findAttr(opAttrs, 'message'));

  // No physical effect — this is an emulator. Log the requested action(s).
  logger.info(
    `IDENTIFY: ${effective.join(', ')}` +
      (message ? ` message=${JSON.stringify(message)}` : '')
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
    ],
  };
}
