/**
 * Print-URI operation (0x0003) — RFC 8011 §4.2.2. WORKING (LOCAL-ONLY).
 *
 * Like Print-Job, but the document is NOT in the request body: the client
 * supplies a `document-uri` (operation attribute) and the PRINTER fetches it.
 * This emulator fetches STRICTLY LOCAL sources only — `file://` and
 * `http://localhost` (see documents/uri-fetch.ts for the anti-SSRF allowlist);
 * any other URI is refused. On a successful fetch the bytes flow through the
 * exact same Job path as Print-Job (sniff document-format, enqueue, run to
 * completion respecting paused-deferral + the render hook).
 *
 * Errors (never throws):
 *   - client-error-uri-scheme-not-supported (0x040C): the document-uri scheme
 *     or host is not on the local-only allowlist.
 *   - client-error-document-access-error (0x0411): the URI was allowed but the
 *     document could not be retrieved (missing file, http error).
 *   - client-error-request-entity-too-large (0x040D): the fetched document
 *     exceeds the size cap.
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
  keywordAttr,
  firstString,
  findAttr,
} from '../attribute.js';
import {
  operationGroup,
  jobGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import { readJobHoldUntil, holdUntilHolds } from '../hold-until.js';
import { readJobTemplate } from '../job-template.js';
import { jobTemplateAttributes } from './job-template-attrs.js';
import { detectFormat, Mime } from '../../documents/formats.js';
import { fetchLocalDocument } from '../../documents/uri-fetch.js';
import { fetchReasonToStatus } from './uri-errors.js';
import { statusResponse } from './subscription-attrs.js';
import { parseRasterInfo } from '../../documents/raster-info.js';
import type { Document } from '../../documents/document.js';
import type { OperationContext } from '../dispatcher.js';

export async function handlePrintUri(
  request: IppRequest,
  ctx: OperationContext
): Promise<IppResponse> {
  // Disable-Printer (RFC 3998): reject new jobs while not accepting (0x0507).
  if (!(ctx.isAcceptingJobs?.() ?? true)) {
    return statusResponse(
      request,
      StatusCodes.SERVER_ERROR_NOT_ACCEPTING_JOBS
    );
  }

  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );
  const jobAttrs = getGroupAttributes(request, DelimiterTags.JOB_ATTRIBUTES);

  const documentUri = firstString(findAttr(opAttrs, 'document-uri'));
  if (!documentUri) {
    // Print-URI without a document-uri is a malformed request.
    return errorResponse(request, StatusCodes.CLIENT_ERROR_BAD_REQUEST);
  }

  // SECURITY: local-only fetch. A non-local URI never leaves this call as a
  // network request — it comes back as reason 'scheme' and is refused below.
  const fetched = await fetchLocalDocument(documentUri);
  if (!fetched.ok) {
    return errorResponse(request, fetchReasonToStatus(fetched.reason));
  }

  const holdUntil = readJobHoldUntil(opAttrs, jobAttrs);
  const template = readJobTemplate(jobAttrs);

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

  const job = ctx.queue.enqueue({
    printerUri: ctx.identity.uri,
    document,
    jobName: firstString(findAttr(opAttrs, 'job-name')),
    requestingUserName: firstString(findAttr(opAttrs, 'requesting-user-name')),
    impressions,
    holdUntil,
    template,
  });

  // Same completion path as Print-Job: run immediately unless held by
  // job-hold-until or deferred while the printer is paused.
  if (!holdUntilHolds(holdUntil) && !ctx.isPaused?.()) {
    job.process();
    ctx.renderRaster?.(job);
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
        ...(job.holdUntil !== undefined
          ? [keywordAttr('job-hold-until', job.holdUntil)]
          : []),
        ...jobTemplateAttributes(job),
        integerAttr('job-impressions', job.impressions),
        integerAttr('job-impressions-completed', job.impressions),
      ]),
    ],
  };
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
