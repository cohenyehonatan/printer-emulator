/**
 * Get-Subscription-Attributes (0x0018) — RFC 3995 §7.5. WORKING.
 *
 * Look up the Subscription named by `notify-subscription-id` (operation
 * attribute) and return its notify-* attributes in a subscription-attributes
 * group. An absent or unknown id (including an expired/cancelled subscription)
 * yields client-error-not-found. Never throws.
 */

import { StatusCodes, DelimiterTags } from '../constants.js';
import { firstNumber, findAttr } from '../attribute.js';
import {
  subscriptionGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import {
  standardOperationGroup,
  statusResponse,
  notFound,
  subscriptionAttributes,
} from './subscription-attrs.js';
import type { OperationContext } from '../dispatcher.js';

export function handleGetSubscriptionAttributes(
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
  const sub = subId !== undefined ? ctx.subscriptions.get(subId) : undefined;

  if (!sub) {
    return notFound(request);
  }

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
    requestId: request.requestId,
    groups: [
      standardOperationGroup(),
      subscriptionGroup(subscriptionAttributes(sub)),
    ],
  };
}
