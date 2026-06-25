/**
 * Get-Notifications (0x001C) — RFC 3996 §10 (the ippget pull delivery method).
 * WORKING.
 *
 * The client supplies one or more `notify-subscription-id` values (1setOf
 * integer, operation attribute); the printer DRAINS each named subscription's
 * queued events and returns one event-notification group (delimiter tag 0x07)
 * per pending event. Each group carries notify-subscription-id,
 * notify-sequence-number, notify-subscribed-event, printer-up-time, and the
 * relevant per-event state (job-id + job-state for job events; printer-state
 * for printer events).
 *
 * Drain semantics: DRAIN-ON-READ — a second Get-Notifications with no new
 * events returns no event groups (the queue was emptied), while the
 * subscription's notify-sequence-number keeps advancing.
 *
 * An unknown/expired subscription id yields client-error-not-found (no event
 * groups). When several ids are supplied and at least one is valid, the valid
 * ones are still drained and successful-ok is returned (per RFC 3996, the
 * not-found ids are simply absent from the response).
 */

import { StatusCodes, DelimiterTags } from '../constants.js';
import {
  integerAttr,
  enumAttr,
  keywordAttr,
  findAttr,
  type IppAttribute,
} from '../attribute.js';
import {
  eventNotificationGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
  type IppAttributeGroup,
} from '../message.js';
import { standardOperationGroup, statusResponse } from './subscription-attrs.js';
import type { EventRecord } from '../../printer/subscription-manager.js';
import type { OperationContext } from '../dispatcher.js';

export function handleGetNotifications(
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
  // The operation attribute is `notify-subscription-ids` (1setOf integer) per
  // RFC 3996 §6.1; accept the singular spelling too for lenient clients.
  const ids = (
    findAttr(opAttrs, 'notify-subscription-ids')?.values ??
    findAttr(opAttrs, 'notify-subscription-id')?.values ??
    []
  )
    .map((v) => v.value)
    .filter((v): v is number => typeof v === 'number');

  if (ids.length === 0) {
    return statusResponse(request, StatusCodes.CLIENT_ERROR_NOT_FOUND);
  }

  const groups: IppAttributeGroup[] = [standardOperationGroup()];
  let anyFound = false;

  for (const id of ids) {
    const events = ctx.subscriptions.drain(id);
    if (events === undefined) continue; // unknown/expired id
    anyFound = true;
    for (const event of events) {
      groups.push(eventNotificationGroup(eventAttributes(id, event)));
    }
  }

  // None of the supplied ids matched a live subscription → not-found.
  if (!anyFound) {
    return statusResponse(request, StatusCodes.CLIENT_ERROR_NOT_FOUND);
  }

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
    requestId: request.requestId,
    groups,
  };
}

/** Build the event-notification attribute list for one delivered event. */
function eventAttributes(subId: number, event: EventRecord): IppAttribute[] {
  const attrs: IppAttribute[] = [
    integerAttr('notify-subscription-id', subId),
    integerAttr('notify-sequence-number', event.sequenceNumber),
    keywordAttr('notify-subscribed-event', event.event),
    integerAttr('printer-up-time', event.printerUpTime),
  ];
  if (event.jobId !== undefined) {
    attrs.push(integerAttr('notify-job-id', event.jobId));
    attrs.push(integerAttr('job-id', event.jobId));
  }
  if (event.jobState !== undefined) {
    attrs.push(enumAttr('job-state', event.jobState));
  }
  if (event.printerState !== undefined) {
    attrs.push(enumAttr('printer-state', event.printerState));
  }
  return attrs;
}
