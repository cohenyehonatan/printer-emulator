/**
 * Send-URI operation (0x0007) — RFC 8011 §4.3.2. WORKING (LOCAL-ONLY).
 *
 * Like Send-Document, but the document is NOT in the request body: the client
 * supplies a `document-uri` (operation attribute) and the PRINTER fetches it,
 * then appends it to an open multi-document job created by Create-Job. The fetch
 * is STRICTLY LOCAL — `file://` + `http://localhost` only (see
 * documents/uri-fetch.ts); any other URI is refused. `last-document=true`
 * releases/runs the job, exactly as Send-Document does.
 *
 * Errors (never throws):
 *   - client-error-not-found (0x0406): the job-id is absent or unknown.
 *   - client-error-not-possible (0x0405): the job is already closed/terminal.
 *   - client-error-uri-scheme-not-supported (0x040C): the document-uri scheme
 *     or host is not on the local-only allowlist.
 *   - client-error-document-access-error (0x0411): allowed but unretrievable.
 *   - client-error-request-entity-too-large (0x040D): over the size cap.
 *
 * Fetch errors are checked AFTER the job is validated (found + still open), so a
 * disallowed URI against a bad job still reports the job problem first — the job
 * is never mutated by a Send-URI that ultimately fails to fetch.
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
import { fetchLocalDocument } from '../../documents/uri-fetch.js';
import { fetchReasonToStatus } from './uri-errors.js';
import { parseRasterInfo } from '../../documents/raster-info.js';
import type { Document } from '../../documents/document.js';
import type { OperationContext } from '../dispatcher.js';

export async function handleSendUri(
  request: IppRequest,
  ctx: OperationContext
): Promise<IppResponse> {
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

  // A closed/terminal job cannot receive further documents.
  if (!job.isOpen) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_POSSIBLE);
  }

  const documentUri = firstString(findAttr(opAttrs, 'document-uri'));
  if (!documentUri) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_BAD_REQUEST);
  }

  // SECURITY: local-only fetch — a non-local URI is refused, not requested.
  const fetched = await fetchLocalDocument(documentUri);
  if (!fetched.ok) {
    return errorResponse(request, fetchReasonToStatus(fetched.reason));
  }

  const bytes = fetched.bytes;
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

  let impressions: number | undefined;
  if (format === Mime.PWG_RASTER || format === Mime.URF) {
    const pages = parseRasterInfo(bytes)?.pages.length;
    if (pages && pages > 0) impressions = pages;
  }

  job.addDocument(document, impressions);

  // last-document=true releases the job and runs the emulated print — unless the
  // printer is paused, in which case the job is deferred (released to pending
  // but not run) for Resume-Printer's runPendingJobs().
  const lastDocument = firstBoolean(findAttr(opAttrs, 'last-document')) ?? false;
  if (lastDocument) {
    const paused = ctx.isPaused?.() ?? false;
    job.close(paused);
    if (!paused) {
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
