/**
 * Get-Subscriptions (0x0019) — RFC 3995 §7.6. WORKING.
 *
 * List the printer's live subscriptions, each as its own subscription-
 * attributes group. Optionally filtered by `notify-job-id` (operation
 * attribute) and/or `my-subscriptions` (a boolean that restricts the list to
 * the requesting user's subscriptions). Always successful-ok — an empty list is
 * a valid response. Never throws.
 */

import { StatusCodes, DelimiterTags } from '../constants.js';
import {
  firstNumber,
  firstBoolean,
  firstString,
  findAttr,
} from '../attribute.js';
import {
  subscriptionGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
  type IppAttributeGroup,
} from '../message.js';
import {
  standardOperationGroup,
  statusResponse,
  subscriptionAttributes,
} from './subscription-attrs.js';
import type { OperationContext } from '../dispatcher.js';

export function handleGetSubscriptions(
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
  const jobId = firstNumber(findAttr(opAttrs, 'notify-job-id'));
  const mine = firstBoolean(findAttr(opAttrs, 'my-subscriptions')) === true;
  const userName = mine
    ? firstString(findAttr(opAttrs, 'requesting-user-name')) ?? 'anonymous'
    : undefined;

  const subs = ctx.subscriptions.list({ jobId, userName });

  const groups: IppAttributeGroup[] = [standardOperationGroup()];
  for (const sub of subs) {
    groups.push(subscriptionGroup(subscriptionAttributes(sub)));
  }

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
    requestId: request.requestId,
    groups,
  };
}
