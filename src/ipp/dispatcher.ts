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
import { handlePrintUri } from './operations/print-uri.js';
import { handleSendUri } from './operations/send-uri.js';
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
import { handleEnablePrinter } from './operations/enable-printer.js';
import { handleDisablePrinter } from './operations/disable-printer.js';
import { handlePausePrinterAfterCurrentJob } from './operations/pause-printer-after-current-job.js';
import { handleHoldNewJobs } from './operations/hold-new-jobs.js';
import { handleReleaseHeldNewJobs } from './operations/release-held-new-jobs.js';
import { handleRestartPrinter } from './operations/restart-printer.js';
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
   * Whether the printer is currently accepting new jobs (RFC 8011 §5.4.20,
   * `printer-is-accepting-jobs`). Toggled by Enable-Printer/Disable-Printer
   * (RFC 3998). When false, the job-creating operations (Print-Job, Create-Job,
   * Print-URI, Send-URI, Validate-Job) reject with server-error-not-accepting-
   * jobs (0x0507). Defaults to "accepting" when absent (bare unit-test contexts).
   */
  isAcceptingJobs?: () => boolean;
  /** Enable-Printer (RFC 3998, 0x0022): set printer-is-accepting-jobs = true. */
  enablePrinter?: () => void;
  /** Disable-Printer (RFC 3998, 0x0023): set printer-is-accepting-jobs = false. */
  disablePrinter?: () => void;
  /**
   * Whether the printer is holding newly submitted jobs (Hold-New-Jobs, RFC
   * 3998, 0x0025). When true, a Print-Job/Create-Job that would otherwise run is
   * instead held (`pending-held`, reason `job-hold-until-specified`) and the
   * printer advertises the `hold-new-jobs` state-reason. Release-Held-New-Jobs
   * (0x0026) clears the flag and runs the held jobs. Defaults false when absent.
   */
  isHoldingNewJobs?: () => boolean;
  /** Hold-New-Jobs (RFC 3998, 0x0025): hold subsequently submitted jobs. */
  holdNewJobs?: () => void;
  /** Release-Held-New-Jobs (RFC 3998, 0x0026): release jobs held by Hold-New-Jobs. */
  releaseHeldNewJobs?: () => void;
  /**
   * Record that a job was held SOLELY because it was submitted while the printer
   * was holding new jobs (Hold-New-Jobs). Release-Held-New-Jobs releases exactly
   * the jobs so marked. Called by the job-creating paths (Print-Job/Create-Job)
   * after they hold a new job for this reason. Absent in bare unit-test contexts.
   */
  markHeldNewJob?: (jobId: number) => void;
  /**
   * Pause-Printer-After-Current-Job (RFC 3998, 0x0024): stop the printer after
   * the currently-processing job finishes. Jobs run synchronously here (no job
   * is ever mid-flight between operations), so this reduces to Pause-Printer —
   * the printer goes `stopped` immediately. Provided as its own hook so the
   * handler maps onto the right semantics.
   */
  pausePrinterAfterCurrentJob?: () => void;
  /**
   * Restart-Printer (RFC 3998, 0x0029): reset the printer to a clean running
   * state — accepting jobs, not paused, not holding new jobs, idle, transient
   * state-reasons cleared. Does NOT purge the job queue (retained jobs survive).
   */
  restartPrinter?: () => void;
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

/**
 * Async operation handler. Print-URI/Send-URI fetch a `document-uri` over the
 * network (loopback only), so they are inherently async — unlike every other
 * operation, which completes synchronously. They are dispatched via
 * dispatchAsync() rather than the synchronous HANDLERS table.
 */
export type AsyncOperationHandler = (
  request: IppRequest,
  ctx: OperationContext
) => Promise<IppResponse>;

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
  // RFC 3998 printer-administrative operations.
  [OperationIds.ENABLE_PRINTER]: handleEnablePrinter,
  [OperationIds.DISABLE_PRINTER]: handleDisablePrinter,
  [OperationIds.PAUSE_PRINTER_AFTER_CURRENT_JOB]:
    handlePausePrinterAfterCurrentJob,
  [OperationIds.HOLD_NEW_JOBS]: handleHoldNewJobs,
  [OperationIds.RELEASE_HELD_NEW_JOBS]: handleReleaseHeldNewJobs,
  [OperationIds.RESTART_PRINTER]: handleRestartPrinter,
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

/**
 * The async-only operations: Print-URI / Send-URI. They fetch a document-uri
 * (loopback-only) before building their response, so they cannot be served from
 * the synchronous HANDLERS table — dispatchAsync() routes them here.
 */
const ASYNC_HANDLERS: Record<number, AsyncOperationHandler> = {
  [OperationIds.PRINT_URI]: handlePrintUri,
  [OperationIds.SEND_URI]: handleSendUri,
};

/**
 * Dispatch a decoded IPP request to its SYNCHRONOUS handler and return the
 * response. Print-URI/Send-URI are not in the sync table; a request for one
 * here returns server-error-operation-not-supported (they must go through
 * dispatchAsync). All existing operations and tests use this path unchanged.
 */
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

/**
 * Dispatch a decoded IPP request, awaiting the async Print-URI/Send-URI handlers
 * when needed and otherwise delegating to the synchronous dispatch(). This is
 * the entry point the HTTP transport uses so the document-uri fetch can complete
 * before the response is encoded. Never throws (handlers map every failure to a
 * status code).
 */
export async function dispatchAsync(
  request: IppRequest,
  ctx: OperationContext
): Promise<IppResponse> {
  const asyncHandler = ASYNC_HANDLERS[request.operationIdOrStatusCode];
  if (asyncHandler) {
    return asyncHandler(request, ctx);
  }
  return dispatch(request, ctx);
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
