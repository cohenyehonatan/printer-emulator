/**
 * Get-Jobs operation (0x000A) — RFC 8011 §4.2.6. STUB-ISH.
 *
 * Returns the queue's jobs, one job-attributes group per job, each carrying
 * job-id, job-uri, job-state, and job-name. Honors neither the `limit` nor the
 * `which-jobs` (completed/not-completed) filters yet — it always lists every
 * tracked job. Never throws; returns successful-ok with whatever is queued.
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
  nameWithoutLangAttr,
} from '../attribute.js';
import {
  operationGroup,
  jobGroup,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { OperationContext } from '../dispatcher.js';

export function handleGetJobs(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  // TODO: honor `limit`, `which-jobs`, and `requested-attributes` filters.
  const jobGroups = ctx.queue.list().map((job) =>
    jobGroup([
      integerAttr('job-id', job.id),
      uriAttr('job-uri', `${ctx.identity.uri}/jobs/${job.id}`),
      enumAttr('job-state', job.stateValue),
      nameWithoutLangAttr('job-name', job.jobName),
    ])
  );

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
      ...jobGroups,
    ],
  };
}
