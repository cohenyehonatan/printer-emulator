/**
 * Send-Document operation (0x0006) — RFC 8011 §4.3.1. WORKING.
 *
 * Appends a document to an existing multi-document job created by Create-Job.
 * Parses the target `job-id` (or the trailing `/jobs/<id>` of a `job-uri`), the
 * `document-number`, the `last-document` boolean, and `document-format`. The
 * trailing IPP message data becomes the document bytes; for PWG/URF the page
 * headers are parsed so the job's accumulated impressions reflect the real page
 * count across every document.
 *
 * `last-document=true` closes the job: the held job is released and the
 * emulated print runs (pending → processing → completed). Until then the job
 * stays open for more documents.
 *
 * Errors (never throws):
 *   - client-error-not-found (0x0406): the job-id is absent or unknown.
 *   - client-error-not-possible (0x0405): the job is already closed/terminal
 *     (a single-shot Print-Job, or an already last-document'd / canceled job).
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  DelimiterTags,
} from '../constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  integerAttr,
  enumAttr,
  uriAttr,
  firstString,
  firstNumber,
  firstBoolean,
  findAttr,
} from '../attribute.js';
import {
  operationGroup,
  jobGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import { detectFormat, Mime } from '../../documents/formats.js';
import { parseRasterInfo } from '../../documents/raster-info.js';
import type { Document } from '../../documents/document.js';
import type { OperationContext } from '../dispatcher.js';

export function handleSendDocument(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );

  const jobId =
    firstNumber(findAttr(opAttrs, 'job-id')) ??
    jobIdFromUri(firstString(findAttr(opAttrs, 'job-uri')));

  const job = jobId !== undefined ? ctx.queue.get(jobId) : undefined;
  if (!job) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_FOUND);
  }

  // A closed/terminal job (single-shot Print-Job, already-closed multi-doc job,
  // or canceled job) cannot receive further documents.
  if (!job.isOpen) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_POSSIBLE);
  }

  const bytes = request.data ?? Buffer.alloc(0);
  const requestedFormat = firstString(findAttr(opAttrs, 'document-format'));
  const format =
    requestedFormat && requestedFormat !== 'application/octet-stream'
      ? requestedFormat
      : detectFormat(bytes);

  const document: Document = {
    name: firstString(findAttr(opAttrs, 'document-name')),
    format,
    bytes,
  };

  // For PWG/URF count pages so accumulated impressions track all documents.
  let impressions: number | undefined;
  if (format === Mime.PWG_RASTER || format === Mime.URF) {
    const pages = parseRasterInfo(bytes)?.pages.length;
    if (pages && pages > 0) impressions = pages;
  }

  job.addDocument(document, impressions);

  // last-document=true releases the job and runs the emulated print — UNLESS
  // the printer is paused, in which case the job is deferred (released to
  // `pending` but not run) for Resume-Printer's runPendingJobs().
  const lastDocument = firstBoolean(findAttr(opAttrs, 'last-document')) ?? false;
  if (lastDocument) {
    const paused = ctx.isPaused?.() ?? false;
    job.close(paused);
    if (!paused) {
      // The closed job has run to completion: render its raster pages (if any
      // output target is configured). Covers every accumulated document.
      ctx.renderRaster?.(job);
    }
  }

  const jobUri = `${ctx.identity.uri}/jobs/${job.id}`;

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
    requestId: request.requestId,
    groups: [
      operationGroup([
        charsetAttr('attributes-charset', DEFAULT_CHARSET),
        naturalLanguageAttr(
          'attributes-natural-language',
          DEFAULT_NATURAL_LANGUAGE
        ),
      ]),
      jobGroup([
        uriAttr('job-uri', jobUri),
        integerAttr('job-id', job.id),
        enumAttr('job-state', job.stateValue),
        integerAttr('job-impressions', job.impressions),
      ]),
    ],
  };
}

/** Extract the numeric job-id from the trailing `/jobs/<id>` of a job-uri. */
function jobIdFromUri(uri: string | undefined): number | undefined {
  if (!uri) return undefined;
  const match = /\/jobs\/(\d+)\/?$/.exec(uri);
  return match ? Number(match[1]) : undefined;
}

/** Build an operation-only error response (no job group). */
function errorResponse(request: IppRequest, status: number): IppResponse {
  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: status,
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
