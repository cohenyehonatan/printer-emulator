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

import { handleGetPrinterAttributes } from './operations/get-printer-attributes.js';
import { handlePrintJob } from './operations/print-job.js';
import { handleValidateJob } from './operations/validate-job.js';
import { handleGetJobs } from './operations/get-jobs.js';
import { handleGetJobAttributes } from './operations/get-job-attributes.js';
import { handleCancelJob } from './operations/cancel-job.js';
import { handleCreateJob } from './operations/create-job.js';
import { handleSendDocument } from './operations/send-document.js';
import { handleCloseJob } from './operations/close-job.js';

/** Shared context passed to every operation handler. */
export interface OperationContext {
  identity: PrinterIdentity;
  queue: JobQueue;
  /** Live printer-state at the moment of the request. */
  printerState: () => PrinterStateValue;
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
  [OperationIds.CREATE_JOB]: handleCreateJob,
  [OperationIds.SEND_DOCUMENT]: handleSendDocument,
  [OperationIds.CLOSE_JOB]: handleCloseJob,
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
