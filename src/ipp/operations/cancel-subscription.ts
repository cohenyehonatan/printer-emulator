/**
 * Cancel-Subscription (0x001B) — RFC 3995 §7.4. WORKING.
 *
 * Remove the Subscription named by `notify-subscription-id` (operation
 * attribute). successful-ok when removed; client-error-not-found when the id is
 * absent or unknown (already cancelled / expired). Never throws.
 */

import { StatusCodes, DelimiterTags } from '../constants.js';
import { firstNumber, findAttr } from '../attribute.js';
import {
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import { statusResponse, notFound } from './subscription-attrs.js';
import type { OperationContext } from '../dispatcher.js';

export function handleCancelSubscription(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  if (!ctx.subscriptions) {
    return statusResponse(
      request,
      StatusCodes.SERVER_ERROR_OPERATION_NOT_SUPPORTED
    );
  }

  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );
  const subId = firstNumber(findAttr(opAttrs, 'notify-subscription-id'));

  if (subId === undefined || !ctx.subscriptions.cancel(subId)) {
    return notFound(request);
  }

  return statusResponse(request, StatusCodes.SUCCESSFUL_OK);
}
