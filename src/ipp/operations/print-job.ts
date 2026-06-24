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
import { detectFormat } from '../../documents/formats.js';
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

  const job = ctx.queue.enqueue({
    printerUri: ctx.identity.uri,
    document,
    jobName: firstString(findAttr(opAttrs, 'job-name')),
    requestingUserName: firstString(
      findAttr(opAttrs, 'requesting-user-name')
    ),
  });

  // Emulated print: immediately drive the job to completion.
  job.process();

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
      ]),
    ],
  };
}
