/**
 * Create-Printer-Subscriptions (0x0016) / Create-Job-Subscriptions (0x0017) —
 * RFC 3995 §7.1 / §7.2. WORKING (pull mode / ippget only).
 *
 * Parse the subscription-attributes group (notify-events, notify-pull-method,
 * notify-lease-duration; notify-recipient-uri must be ABSENT for pull), create
 * a Subscription via the manager, and return a subscription-attributes group
 * carrying the granted notify-subscription-id + notify-lease-duration.
 *
 * Status:
 *   - successful-ok when the subscription was created as requested;
 *   - successful-ok-ignored-or-substituted-attributes when a requested
 *     notify-events keyword was unsupported and dropped;
 *   - client-error-attributes-or-values-not-supported when the request asks for
 *     a non-ippget pull method or supplies a notify-recipient-uri (push), which
 *     this pull-only emulator cannot honor — no subscription is created.
 * Never throws.
 *
 * Create-Job-Subscriptions additionally reads notify-job-id (the job the
 * subscription is scoped to) from the operation attributes.
 */

import {
  StatusCodes,
  DelimiterTags,
} from '../constants.js';
import { firstNumber, findAttr, firstString } from '../attribute.js';
import {
  subscriptionGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import {
  standardOperationGroup,
  statusResponse,
  subscriptionAttributes,
  parseSubscriptionRequest,
} from './subscription-attrs.js';
import type { OperationContext } from '../dispatcher.js';

export function handleCreatePrinterSubscriptions(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  return createSubscriptions(request, ctx, /* perJob */ false);
}

export function handleCreateJobSubscriptions(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  return createSubscriptions(request, ctx, /* perJob */ true);
}

function createSubscriptions(
  request: IppRequest,
  ctx: OperationContext,
  perJob: boolean
): IppResponse {
  if (!ctx.subscriptions) {
    return statusResponse(
      request,
      StatusCodes.SERVER_ERROR_OPERATION_NOT_SUPPORTED
    );
  }

  const parsed = parseSubscriptionRequest(request);

  // Pull-only: reject a non-ippget pull method or a notify-recipient-uri
  // (push). No subscription is created.
  if (parsed.pullMethodUnsupported) {
    return statusResponse(
      request,
      StatusCodes.CLIENT_ERROR_ATTRIBUTES_NOT_SUPPORTED
    );
  }

  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );

  // notify-job-id: required for Create-Job-Subscriptions (scopes the
  // subscription to that job); ignored for the printer-wide create.
  const jobId = perJob
    ? firstNumber(findAttr(opAttrs, 'notify-job-id')) ??
      firstNumber(findAttr(opAttrs, 'job-id'))
    : undefined;

  const userName = firstString(findAttr(opAttrs, 'requesting-user-name'));

  const sub = ctx.subscriptions.create({
    events: parsed.events,
    leaseDuration: parsed.leaseDuration,
    jobId,
    userName,
  });

  const status = parsed.eventsIgnored
    ? StatusCodes.SUCCESSFUL_OK_IGNORED_OR_SUBSTITUTED
    : StatusCodes.SUCCESSFUL_OK;

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: status,
    requestId: request.requestId,
    groups: [
      standardOperationGroup(),
      subscriptionGroup(subscriptionAttributes(sub)),
    ],
  };
}
