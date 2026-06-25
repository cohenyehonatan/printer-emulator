/**
 * Renew-Subscription (0x001A) — RFC 3995 §7.3. WORKING.
 *
 * Extend the lease of the Subscription named by `notify-subscription-id`
 * (operation attribute) by the requested `notify-lease-duration` (in the
 * subscription-attributes group, or absent → the default). Returns a
 * subscription-attributes group with the granted notify-lease-duration.
 * client-error-not-found when the id is absent or unknown. Never throws.
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

export function handleRenewSubscription(
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

  // The requested new lease lives in the subscription-attributes group.
  const subAttrs = getGroupAttributes(
    request,
    DelimiterTags.SUBSCRIPTION_ATTRIBUTES
  );
  const requested = firstNumber(findAttr(subAttrs, 'notify-lease-duration'));
  sub.renew(requested, Date.now());

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
