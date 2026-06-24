/**
 * Get-Jobs operation (0x000A) — RFC 8011 §4.2.6. WORKING.
 *
 * Returns one job-attributes group per job (job-id, job-uri, job-state,
 * job-name), honoring the two standard filters:
 *   - `which-jobs` (keyword): `not-completed` (DEFAULT — pending, pending-held,
 *     processing, processing-stopped), `completed` (completed, canceled,
 *     aborted), or `all`. An unrecognized value falls back to the default.
 *   - `limit` (integer): caps the number of returned job groups (ignored when
 *     absent or non-positive).
 * Jobs are returned in stable job-id order. The standard per-job attribute set
 * is filtered through the `requested-attributes` sub-selection (mirroring
 * Get-Job-Attributes / Get-Printer-Attributes); when that attribute is absent
 * the full per-job set is returned. Returns successful-ok with an empty set
 * when nothing matches. Never throws.
 */

import {
  StatusCodes,
  JobStates,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  DelimiterTags,
  type JobStateValue,
} from '../constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  integerAttr,
  enumAttr,
  uriAttr,
  keywordAttr,
  nameWithoutLangAttr,
  firstNumber,
  firstString,
  findAttr,
  type IppAttribute,
} from '../attribute.js';
import {
  operationGroup,
  jobGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import {
  readRequestedAttributes,
  selectAttributes,
} from '../requested-attributes.js';
import type { Job } from '../../printer/job.js';
import type { OperationContext } from '../dispatcher.js';

/** Terminal job-states reported by `which-jobs=completed`. */
const COMPLETED_STATES: readonly JobStateValue[] = [
  JobStates.COMPLETED,
  JobStates.CANCELED,
  JobStates.ABORTED,
] as const;

/** Active job-states reported by `which-jobs=not-completed` (the default). */
const NOT_COMPLETED_STATES: readonly JobStateValue[] = [
  JobStates.PENDING,
  JobStates.PENDING_HELD,
  JobStates.PROCESSING,
  JobStates.PROCESSING_STOPPED,
] as const;

export function handleGetJobs(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );

  const whichJobs = firstString(findAttr(opAttrs, 'which-jobs'));
  const limit = firstNumber(findAttr(opAttrs, 'limit'));

  // Stable order by job-id, then filter by which-jobs, then cap to limit.
  const ordered = [...ctx.queue.list()].sort((a, b) => a.id - b.id);
  const filtered = ordered.filter((job) => matchesWhichJobs(job, whichJobs));
  const selected =
    limit !== undefined && limit > 0 ? filtered.slice(0, limit) : filtered;

  // requested-attributes sub-selection: absent → full per-job set (back-compat).
  const requested = readRequestedAttributes(request);
  const jobGroups = selected.map((job) => {
    const perJob: IppAttribute[] = [
      integerAttr('job-id', job.id),
      uriAttr('job-uri', `${ctx.identity.uri}/jobs/${job.id}`),
      enumAttr('job-state', job.stateValue),
      nameWithoutLangAttr('job-name', job.jobName),
    ];
    // Echo `job-hold-until` only when the client specified one (keeps the
    // default per-job set unchanged for jobs without a hold-until).
    if (job.holdUntil !== undefined) {
      perJob.push(keywordAttr('job-hold-until', job.holdUntil));
    }
    // Echo job-priority/copies only once set (Set-Job-Attributes), keeping the
    // default per-job set unchanged for jobs that never carried them.
    if (job.jobPriority !== undefined) {
      perJob.push(integerAttr('job-priority', job.jobPriority));
    }
    if (job.copies !== undefined) {
      perJob.push(integerAttr('copies', job.copies));
    }
    return jobGroup(selectAttributes(perJob, requested));
  });

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

/**
 * Decide whether a job passes the `which-jobs` filter. `not-completed` is the
 * RFC default; `all` passes everything; an unrecognized keyword falls back to
 * the default rather than erroring.
 */
function matchesWhichJobs(job: Job, whichJobs: string | undefined): boolean {
  switch (whichJobs) {
    case 'completed':
      return COMPLETED_STATES.includes(job.stateValue);
    case 'all':
      return true;
    case 'not-completed':
    default:
      return NOT_COMPLETED_STATES.includes(job.stateValue);
  }
}
