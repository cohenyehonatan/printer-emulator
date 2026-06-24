/**
 * Print-Job operation (0x0002) — RFC 8011 §4.2.1. WORKING.
 *
 * Accepts the trailing document data, sniffs/uses its document-format,
 * enqueues a Job, runs the emulated print (pending -> processing -> completed),
 * and returns successful-ok with a job-attributes group (job-uri, job-id,
 * job-state). This is the core "print something" path.
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
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
import { DelimiterTags } from '../constants.js';
import { readJobHoldUntil, holdUntilHolds } from '../hold-until.js';
import { detectFormat, Mime } from '../../documents/formats.js';
import { parseRasterInfo } from '../../documents/raster-info.js';
import type { Document } from '../../documents/document.js';
import type { OperationContext } from '../dispatcher.js';

export function handlePrintJob(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );
  const jobAttrs = getGroupAttributes(request, DelimiterTags.JOB_ATTRIBUTES);

  // job-hold-until (RFC 8011 §5.2.2): a holding value (anything but `no-hold`)
  // makes the job start `pending-held` so it is NOT run until a Release-Job.
  const holdUntil = readJobHoldUntil(opAttrs, jobAttrs);

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

  // For PWG-Raster / URF, parse the page headers so job-impressions reflects
  // the real page count. Other formats are not counted (impressions defaults
  // to 1). parseRasterInfo never throws.
  let impressions: number | undefined;
  if (format === Mime.PWG_RASTER || format === Mime.URF) {
    const pages = parseRasterInfo(bytes)?.pages.length;
    if (pages && pages > 0) impressions = pages;
  }

  const job = ctx.queue.enqueue({
    printerUri: ctx.identity.uri,
    document,
    jobName: firstString(findAttr(opAttrs, 'job-name')),
    requestingUserName: firstString(
      findAttr(opAttrs, 'requesting-user-name')
    ),
    impressions,
    holdUntil,
  });

  // Emulated print: immediately drive the job to completion — UNLESS either:
  //   - a holding `job-hold-until` was requested (the job is `pending-held` and
  //     waits for an explicit Release-Job), or
  //   - the printer is paused (the job is deferred, left `pending`, and run
  //     later by Resume-Printer's runPendingJobs()).
  // In both cases the response reports the held/pending state, not `completed`.
  if (!holdUntilHolds(holdUntil) && !ctx.isPaused?.()) {
    job.process();

    // "Actually print": render PWG/URF pages to PNGs when output is configured.
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
        integerAttr('job-impressions', job.impressions),
        integerAttr('job-impressions-completed', job.impressions),
      ]),
    ],
  };
}
