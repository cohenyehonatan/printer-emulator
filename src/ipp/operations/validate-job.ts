/**
 * Validate-Job operation (0x0004) — RFC 8011 §4.2.3. WORKING.
 *
 * Validates that the printer could accept the supplied job/operation
 * attributes without actually creating a job. This emulator accepts any
 * well-formed request and returns successful-ok with the required operation
 * attributes — exactly what a client uses to pre-flight a print.
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
} from '../constants.js';
import { charsetAttr, naturalLanguageAttr } from '../attribute.js';
import {
  operationGroup,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { OperationContext } from '../dispatcher.js';

export function handleValidateJob(
  request: IppRequest,
  _ctx: OperationContext
): IppResponse {
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
