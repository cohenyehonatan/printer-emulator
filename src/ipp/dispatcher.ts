/**
 * IPP operation dispatcher.
 *
 * Maps the request's operation-id to a handler (RFC 8011 operations) and
 * returns the handler's IppResponse. Unknown operations yield a well-formed
 * server-error-operation-not-supported response rather than throwing, so the
 * HTTP layer can always serialize a reply.
 *
 * OperationContext is the shared seam handlers use to reach printer state:
 * its identity, live printer-state, and job queue.
 */

import {
  OperationIds,
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  type PrinterStateValue,
} from './constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
} from './attribute.js';
import {
  operationGroup,
  type IppRequest,
  type IppResponse,
} from './message.js';
import type { PrinterIdentity } from '../printer/printer-attributes.js';
import type { JobQueue } from '../printer/job-queue.js';
import type { Job } from '../printer/job.js';
import type { SubscriptionManager } from '../printer/subscription-manager.js';

import { handleGetPrinterAttributes } from './operations/get-printer-attributes.js';
import { handlePrintJob } from './operations/print-job.js';
import { handleValidateJob } from './operations/validate-job.js';
import { handleGetJobs } from './operations/get-jobs.js';
import { handleGetJobAttributes } from './operations/get-job-attributes.js';
import { handleCancelJob } from './operations/cancel-job.js';
import { handlePurgeJobs } from './operations/purge-jobs.js';
import { handleCancelMyJobs } from './operations/cancel-my-jobs.js';
import { handleCreateJob } from './operations/create-job.js';
import { handleSendDocument } from './operations/send-document.js';
import { handleCloseJob } from './operations/close-job.js';
import { handleHoldJob } from './operations/hold-job.js';
import { handleReleaseJob } from './operations/release-job.js';
import { handleRestartJob } from './operations/restart-job.js';
import { handlePausePrinter } from './operations/pause-printer.js';
import { handleResumePrinter } from './operations/resume-printer.js';
import { handleIdentifyPrinter } from './operations/identify-printer.js';
import { handleSetPrinterAttributes } from './operations/set-printer-attributes.js';
import { handleSetJobAttributes } from './operations/set-job-attributes.js';
import {
  handleCreatePrinterSubscriptions,
  handleCreateJobSubscriptions,
} from './operations/create-subscriptions.js';
import { handleGetSubscriptionAttributes } from './operations/get-subscription-attributes.js';
import { handleGetSubscriptions } from './operations/get-subscriptions.js';
import { handleCancelSubscription } from './operations/cancel-subscription.js';
import { handleRenewSubscription } from './operations/renew-subscription.js';
import { handleGetNotifications } from './operations/get-notifications.js';

/** Shared context passed to every operation handler. */
export interface OperationContext {
  identity: PrinterIdentity;
  queue: JobQueue;
  /**
   * Optional `ipps://…` URI, present only when the TLS/IPPS server is running.
   * Get-Printer-Attributes adds it to printer-uri-supported (with `tls`
   * security) so AirPrint clients learn the secure endpoint. Absent (default)
   * keeps the advertised attribute set identical to the plaintext-only printer.
   */
  ippsUri?: string;
  /** Live printer-state at the moment of the request. */
  printerState: () => PrinterStateValue;
  /**
   * Live printer-state-reasons keyword(s) at the moment of the request
   * (`['paused']` while paused, else `['none']`). Optional so bare unit-test
   * contexts can omit it — the get-printer-attributes path defaults to
   * `['none']` when it is absent.
   */
  printerStateReasons?: () => string[];
  /**
   * Whether the printer is currently paused (Pause-Printer). While paused, the
   * job-running paths (Print-Job after enqueue; Send-Document/Close-Job/
   * Release-Job on release) must DEFER the job — leaving it `pending` rather
   * than running it to completion. Resume-Printer later runs the deferred jobs.
   * Defaults to "not paused" when the field is absent (e.g. unit-test contexts).
   */
  isPaused?: () => boolean;
  /** Pause the printer: drives printer-state to stopped and defers jobs. */
  pausePrinter?: () => void;
  /** Resume the printer and run any deferred pending jobs to completion. */
  resumePrinter?: () => void;
  /**
   * Optional "actually print" hook: invoked with a finished raster job so the
   * emulator can render its PWG/URF pages to PNGs. Present only when an output
   * target is configured (RASTER_OUT / --raster-out); absent by default so
   * normal runs/tests write nothing. Never throws.
   */
  renderRaster?: (job: Job) => void;
  /**
   * Apply settable printer-description attributes (Set-Printer-Attributes, RFC
   * 3380 §4.1) as overrides on the live printer identity, so a subsequent
   * Get-Printer-Attributes reflects them. `overrides` is a partial of the
   * settable PrinterIdentity fields (printer-name → name, printer-info → info,
   * printer-location → location, …). Optional so bare unit-test contexts can
   * omit it — the Set-Printer-Attributes handler then mutates `ctx.identity`
   * directly as a fallback. Real IPP gates this behind operator policy; the
   * emulator has no auth layer (see README).
   */
  setPrinterAttributes?: (overrides: Partial<PrinterIdentity>) => void;
  /**
   * Event-notification subscription manager (RFC 3995 / RFC 3996), present when
   * the printer supports pull-mode notifications. The subscription operations
   * (Create-*-Subscriptions, Get-Subscription(s)-Attributes, Cancel/Renew-
   * Subscription, Get-Notifications) reach it through here. Optional so bare
   * unit-test contexts can omit it — those operations then return not-found /
   * operation-not-supported semantics gracefully.
   */
  subscriptions?: SubscriptionManager;
  /**
   * Live printer-up-time in seconds (RFC 8011 §5.4.29) — seconds since the
   * printer object started. Surfaced in Get-Printer-Attributes and stamped onto
   * each delivered event-notification. Optional; defaults to 0 when absent.
   */
  printerUpTime?: () => number;
}

export type OperationHandler = (
  request: IppRequest,
  ctx: OperationContext
) => IppResponse;

const HANDLERS: Record<number, OperationHandler> = {
  [OperationIds.GET_PRINTER_ATTRIBUTES]: handleGetPrinterAttributes,
  [OperationIds.PRINT_JOB]: handlePrintJob,
  [OperationIds.VALIDATE_JOB]: handleValidateJob,
  [OperationIds.GET_JOBS]: handleGetJobs,
  [OperationIds.GET_JOB_ATTRIBUTES]: handleGetJobAttributes,
  [OperationIds.CANCEL_JOB]: handleCancelJob,
  [OperationIds.PURGE_JOBS]: handlePurgeJobs,
  [OperationIds.CANCEL_MY_JOBS]: handleCancelMyJobs,
  [OperationIds.CREATE_JOB]: handleCreateJob,
  [OperationIds.SEND_DOCUMENT]: handleSendDocument,
  [OperationIds.CLOSE_JOB]: handleCloseJob,
  [OperationIds.HOLD_JOB]: handleHoldJob,
  [OperationIds.RELEASE_JOB]: handleReleaseJob,
  [OperationIds.RESTART_JOB]: handleRestartJob,
  [OperationIds.PAUSE_PRINTER]: handlePausePrinter,
  [OperationIds.RESUME_PRINTER]: handleResumePrinter,
  [OperationIds.IDENTIFY_PRINTER]: handleIdentifyPrinter,
  [OperationIds.SET_PRINTER_ATTRIBUTES]: handleSetPrinterAttributes,
  [OperationIds.SET_JOB_ATTRIBUTES]: handleSetJobAttributes,
  [OperationIds.CREATE_PRINTER_SUBSCRIPTIONS]: handleCreatePrinterSubscriptions,
  [OperationIds.CREATE_JOB_SUBSCRIPTIONS]: handleCreateJobSubscriptions,
  [OperationIds.GET_SUBSCRIPTION_ATTRIBUTES]: handleGetSubscriptionAttributes,
  [OperationIds.GET_SUBSCRIPTIONS]: handleGetSubscriptions,
  [OperationIds.CANCEL_SUBSCRIPTION]: handleCancelSubscription,
  [OperationIds.RENEW_SUBSCRIPTION]: handleRenewSubscription,
  [OperationIds.GET_NOTIFICATIONS]: handleGetNotifications,
};

/** Dispatch a decoded IPP request to its handler and return the response. */
export function dispatch(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const handler = HANDLERS[request.operationIdOrStatusCode];
  if (!handler) {
    return notSupported(request);
  }
  return handler(request, ctx);
}

/** Build the standard server-error-operation-not-supported response. */
function notSupported(request: IppRequest): IppResponse {
  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: StatusCodes.SERVER_ERROR_OPERATION_NOT_SUPPORTED,
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
