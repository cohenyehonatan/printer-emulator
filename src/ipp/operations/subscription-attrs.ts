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
import { isLocalOnlyHttpUri } from '../../transport/local-only.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  integerAttr,
  keywordAttr,
  uriAttr,
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
    integerAttr('notify-lease-duration', sub.leaseDuration),
    integerAttr('notify-sequence-number', sub.lastSequence),
  ];
  // A PUSH subscription reports its recipient URI (RFC 3995 §5.3.2) instead of a
  // pull method; a PULL subscription reports notify-pull-method=ippget.
  if (sub.recipientUri !== undefined) {
    attrs.push(uriAttr('notify-recipient-uri', sub.recipientUri));
  } else {
    attrs.push(keywordAttr('notify-pull-method', sub.pullMethod));
  }
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
  /**
   * The validated, LOCAL-ONLY push recipient URI when this is a PUSH
   * subscription (notify-recipient-uri supplied AND on the loopback allowlist).
   * Undefined for a pull (ippget) subscription.
   */
  recipientUri: string | undefined;
  /**
   * When set, the request must be REJECTED with this IPP status code and no
   * subscription created:
   *   - CLIENT_ERROR_URI_SCHEME_NOT_SUPPORTED — a notify-recipient-uri (push)
   *     whose scheme/host is not on the local-only allowlist (the SSRF guard,
   *     exactly as Print-URI refuses a non-local document-uri).
   *   - CLIENT_ERROR_ATTRIBUTES_NOT_SUPPORTED — a notify-pull-method other than
   *     ippget (with no recipient-uri).
   * Undefined when the request is acceptable.
   */
  rejectStatus: number | undefined;
}

const SUPPORTED_EVENT_SET = new Set<string>(Object.values(NotifyEvents));

/**
 * Parse the subscription-attributes group (tag 0x06) of a create request. When
 * a client sends no such group (or no notify-events), defaults to a single
 * `job-completed` subscription so a bare create still produces a usable
 * subscription. Unknown notify-events keywords are filtered out (and the
 * `eventsIgnored` flag set).
 *
 * Delivery method:
 *   - A `notify-recipient-uri` makes this a PUSH subscription. It is accepted
 *     ONLY when the URI passes the LOCAL-ONLY allowlist (isLocalOnlyHttpUri —
 *     the SAME loopback guard Print-URI uses for document-uri). A non-local
 *     recipient is REJECTED with client-error-uri-scheme-not-supported, exactly
 *     as Print-URI refuses a non-local document-uri.
 *   - Otherwise it is a PULL (ippget) subscription. A notify-pull-method other
 *     than `ippget` is rejected with client-error-attributes-or-values-not-
 *     supported.
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

  const pullMethod = firstString(findAttr(subAttrs, 'notify-pull-method'));
  const recipientUri = firstString(findAttr(subAttrs, 'notify-recipient-uri'));

  const leaseDuration = firstNumber(findAttr(subAttrs, 'notify-lease-duration'));

  const base = {
    events: events.length > 0 ? events : [NotifyEvents.JOB_COMPLETED],
    eventsIgnored: eventsIgnored && events.length > 0,
    leaseDuration,
  };

  // PUSH: a notify-recipient-uri was supplied. Accept only a LOCAL-ONLY http
  // loopback URI; reject everything else with uri-scheme-not-supported (the
  // SSRF guard — identical to Print-URI's refusal of a non-local document-uri).
  if (recipientUri !== undefined) {
    if (!isLocalOnlyHttpUri(recipientUri)) {
      return {
        ...base,
        recipientUri: undefined,
        rejectStatus: StatusCodes.CLIENT_ERROR_URI_SCHEME_NOT_SUPPORTED,
      };
    }
    return { ...base, recipientUri, rejectStatus: undefined };
  }

  // PULL: a notify-pull-method other than ippget is not supported.
  if (pullMethod !== undefined && pullMethod !== NOTIFY_PULL_METHOD_IPPGET) {
    return {
      ...base,
      recipientUri: undefined,
      rejectStatus: StatusCodes.CLIENT_ERROR_ATTRIBUTES_NOT_SUPPORTED,
    };
  }

  return { ...base, recipientUri: undefined, rejectStatus: undefined };
}
