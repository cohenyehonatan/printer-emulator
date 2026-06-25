/**
 * Shared helpers for the event-notification subscription operations (RFC 3995 /
 * RFC 3996): the standard operation-attributes header, the operation-only error
 * response, the subscription-attributes group builder, and the request parser
 * for the notify-* attributes that arrive in a subscription-attributes group.
 *
 * Kept in one place so Create-*-Subscriptions, Get-Subscription(s)-Attributes,
 * Renew/Cancel-Subscription, and Get-Notifications stay consistent.
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  DelimiterTags,
  NotifyEvents,
  NOTIFY_PULL_METHOD_IPPGET,
} from '../constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  integerAttr,
  keywordAttr,
  allStrings,
  firstNumber,
  firstString,
  findAttr,
  type IppAttribute,
} from '../attribute.js';
import {
  operationGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { Subscription } from '../../printer/subscription-manager.js';

/** The standard leading operation-attributes group (charset + language). */
export function standardOperationGroup() {
  return operationGroup([
    charsetAttr('attributes-charset', DEFAULT_CHARSET),
    naturalLanguageAttr('attributes-natural-language', DEFAULT_NATURAL_LANGUAGE),
  ]);
}

/** Build an operation-only response with the given status (no extra groups). */
export function statusResponse(
  request: IppRequest,
  status: number
): IppResponse {
  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: status,
    requestId: request.requestId,
    groups: [standardOperationGroup()],
  };
}

/** A client-error-not-found operation-only response. */
export function notFound(request: IppRequest): IppResponse {
  return statusResponse(request, StatusCodes.CLIENT_ERROR_NOT_FOUND);
}

/**
 * Build the notify-* attribute list describing a Subscription, for a
 * subscription-attributes group (Get-Subscription-Attributes / Get-
 * Subscriptions, and the create responses). Mirrors RFC 3995 §5.3.
 */
export function subscriptionAttributes(sub: Subscription): IppAttribute[] {
  const attrs: IppAttribute[] = [
    integerAttr('notify-subscription-id', sub.id),
    keywordAttr('notify-events', ...sub.events),
    keywordAttr('notify-pull-method', sub.pullMethod),
    integerAttr('notify-lease-duration', sub.leaseDuration),
    integerAttr('notify-sequence-number', sub.lastSequence),
  ];
  if (sub.jobId !== undefined) {
    attrs.push(integerAttr('notify-job-id', sub.jobId));
  }
  return attrs;
}

/**
 * The notify-* values a client supplied in the subscription-attributes group of
 * a Create-*-Subscriptions request, plus a flag for whether any requested
 * `notify-events` keyword was dropped (unsupported) and whether the request is
 * invalid for pull mode (a non-ippget pull method or a notify-recipient-uri,
 * which implies push). Never throws.
 */
export interface ParsedSubscriptionRequest {
  events: string[];
  /** True when one or more requested notify-events keywords were dropped. */
  eventsIgnored: boolean;
  leaseDuration: number | undefined;
  /** True when the request is incompatible with pull (ippget-only) delivery. */
  pullMethodUnsupported: boolean;
}

const SUPPORTED_EVENT_SET = new Set<string>(Object.values(NotifyEvents));

/**
 * Parse the subscription-attributes group (tag 0x06) of a create request. When
 * a client sends no such group (or no notify-events), defaults to a single
 * `job-completed` subscription so a bare create still produces a usable
 * subscription. Unknown notify-events keywords are filtered out (and the
 * `eventsIgnored` flag set). A notify-pull-method other than `ippget`, or a
 * present notify-recipient-uri, marks the request pull-unsupported.
 */
export function parseSubscriptionRequest(
  request: IppRequest
): ParsedSubscriptionRequest {
  const subAttrs = getGroupAttributes(
    request,
    DelimiterTags.SUBSCRIPTION_ATTRIBUTES
  );

  const requested = allStrings(findAttr(subAttrs, 'notify-events'));
  const events = requested.filter((e) => SUPPORTED_EVENT_SET.has(e));
  const eventsIgnored = events.length < requested.length;

  // A present notify-recipient-uri implies PUSH delivery, which this emulator
  // does not do; a notify-pull-method must be `ippget`.
  const pullMethod = firstString(findAttr(subAttrs, 'notify-pull-method'));
  const recipientUri = firstString(findAttr(subAttrs, 'notify-recipient-uri'));
  const pullMethodUnsupported =
    recipientUri !== undefined ||
    (pullMethod !== undefined && pullMethod !== NOTIFY_PULL_METHOD_IPPGET);

  const leaseDuration = firstNumber(findAttr(subAttrs, 'notify-lease-duration'));

  return {
    events: events.length > 0 ? events : [NotifyEvents.JOB_COMPLETED],
    eventsIgnored: eventsIgnored && events.length > 0,
    leaseDuration,
    pullMethodUnsupported,
  };
}
