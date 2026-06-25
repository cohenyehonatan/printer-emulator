/**
 * PUSH delivery of event-notifications to a subscription's `notify-recipient-uri`
 * (RFC 3995 §9 / §11 — the "ippget"/notification-content push complement of the
 * Get-Notifications pull path).
 *
 * ┌─────────────────────────── SECURITY ───────────────────────────────────┐
 * │ This is an OUTBOUND network feature: when an event fires, the printer    │
 * │ POSTs to a CLIENT-SUPPLIED recipient URI. That is an SSRF primitive, so  │
 * │ it is HARD-RESTRICTED to LOCAL-ONLY recipients using the EXACT SAME guard │
 * │ as Print-URI/Send-URI — isLocalOnlyHttpUri() from transport/local-only.ts │
 * │ (string-equality loopback host allowlist, never a DNS lookup). A          │
 * │ recipient URI is validated AT SUBSCRIPTION-CREATE time (rejected with     │
 * │ client-error-uri-scheme-not-supported if non-local), and re-checked here  │
 * │ defensively before every POST. There is NO redirect following, a SHORT    │
 * │ timeout, and the request socket is unref()'d so a pending delivery never  │
 * │ keeps the process (or a `vitest run`) alive. Delivery is FIRE-AND-FORGET: │
 * │ every failure is swallowed — a dead/refusing recipient must never crash   │
 * │ the printer or block job processing.                                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * BODY FORMAT (documented choice): each POST carries an `application/ipp` binary
 * message (RFC 8010 §3) shaped as a Send-Notifications request (operation-id
 * 0x001D, RFC 3995 §11.1): the standard operation-attributes group (charset +
 * natural-language) followed by ONE event-notification group (delimiter tag
 * 0x07, RFC 3996 §10) per delivered event — byte-for-byte the same group a
 * Get-Notifications response carries, so a push recipient and a pull poller see
 * identical event encodings. Each group holds notify-subscription-id,
 * notify-sequence-number, notify-subscribed-event, printer-up-time, and the
 * per-event state (notify-job-id/job-id + job-state for job events;
 * printer-state for printer events).
 */

import { request as httpRequest } from 'http';
import {
  IPP_CONTENT_TYPE,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
  OperationIds,
  DelimiterTags,
} from '../ipp/constants.js';
import {
  integerAttr,
  enumAttr,
  keywordAttr,
  uriAttr,
  type IppAttribute,
} from '../ipp/attribute.js';
import {
  standardOperationGroup,
} from '../ipp/operations/subscription-attrs.js';
import { eventNotificationGroup, type IppMessage } from '../ipp/message.js';
import { encode } from '../ipp/encoder.js';
import { isLocalOnlyHttpUri } from '../transport/local-only.js';
import type { EventRecord } from './subscription-manager.js';

/** How long (ms) a push POST may take before it is abandoned. Short on purpose. */
export const PUSH_DELIVERY_TIMEOUT_MS = 3000;

/** A monotonic request-id source for the synthetic Send-Notifications messages. */
let pushRequestId = 1;

/**
 * Build the event-notification attribute list for one delivered event. Mirrors
 * get-notifications.ts so push and pull encode events identically.
 */
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

/**
 * Build the `application/ipp` Send-Notifications message body for a single
 * delivered event (see BODY FORMAT in the header). `recipientUri` is echoed as
 * the operation's notify-recipient-uri so the receiver can correlate.
 */
export function buildPushBody(
  subId: number,
  event: EventRecord,
  recipientUri: string
): Buffer {
  const msg: IppMessage = {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: OperationIds.SEND_NOTIFICATIONS,
    requestId: pushRequestId++,
    groups: [
      {
        tag: DelimiterTags.OPERATION_ATTRIBUTES,
        attributes: [
          ...standardOperationGroup().attributes,
          uriAttr('notify-recipient-uri', recipientUri),
        ],
      },
      eventNotificationGroup(eventAttributes(subId, event)),
    ],
  };
  return encode(msg);
}

/**
 * Deliver one event to a push subscription's recipient URI by HTTP POST.
 * FIRE-AND-FORGET and LOCAL-ONLY: the recipient is re-validated against the
 * loopback allowlist (a non-local URI is silently dropped — it should never have
 * been accepted at create time), the POST runs with a short timeout, no redirect
 * following, and the socket is unref()'d so it can never keep the process alive.
 * Never throws and never rejects; resolves when the attempt has settled (used by
 * tests to await delivery, but callers in the hot path do not await).
 */
export function deliverPush(
  recipientUri: string,
  subId: number,
  event: EventRecord
): Promise<void> {
  return new Promise<void>((resolve) => {
    // Defensive re-check — SAME guard as Print-URI/Send-URI. A non-local
    // recipient must never be contacted, even if it somehow got stored.
    if (!isLocalOnlyHttpUri(recipientUri)) {
      resolve();
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(recipientUri);
    } catch {
      resolve();
      return;
    }

    let body: Buffer;
    try {
      body = buildPushBody(subId, event, recipientUri);
    } catch {
      resolve();
      return;
    }

    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const req = httpRequest(
      {
        protocol: 'http:',
        hostname: parsed.hostname,
        port: parsed.port,
        path: (parsed.pathname || '/') + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': IPP_CONTENT_TYPE,
          'Content-Length': body.length,
        },
        timeout: PUSH_DELIVERY_TIMEOUT_MS,
      },
      (res) => {
        // Drain and discard the response — we do not act on the recipient's
        // reply, and we never follow a redirect to a non-local Location.
        res.on('data', () => {});
        res.on('end', finish);
        res.on('error', finish);
      }
    );

    // Never let a pending delivery keep the event loop (or `vitest run`) alive.
    req.on('socket', (socket) => socket.unref());
    req.on('timeout', () => {
      req.destroy();
      finish();
    });
    req.on('error', finish);
    req.write(body);
    req.end();
  });
}
