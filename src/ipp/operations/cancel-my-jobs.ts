/**
 * Cancel-My-Jobs operation (0x0039) — RFC 3998. WORKING.
 *
 * Cancels all NOT-COMPLETED jobs (pending, pending-held, processing,
 * processing-stopped) owned by the `requesting-user-name` from the operation
 * attributes. Each matching job is canceled via the existing job.cancel() path
 * (the same CANCEL state-machine transition Cancel-Job uses); a job that cannot
 * transition (already terminal) is skipped. Already-terminal jobs (completed /
 * canceled / aborted) are left untouched. Always returns successful-ok. Never
 * throws.
 *
 * Selection details:
 *   - Ownership is matched against each job's requestingUserName.
 *   - When the optional `job-ids` (1setOf integer) operation attribute is
 *     supplied, the cancel set is RESTRICTED to those ids (still gated to the
 *     owner's not-completed jobs) — honoring RFC 3998's job-ids scoping.
 *   - When `requesting-user-name` is ABSENT, we fall back to cancelling ALL
 *     not-completed jobs (still honoring job-ids if present). The emulator has
 *     no auth identity, so there is no "current user" to default to; this
 *     fallback makes the operation useful from an anonymous client (it behaves
 *     like an unauthenticated "cancel everything in flight").
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
  firstString,
  findAttr,
  type IppAttribute,
} from '../attribute.js';
import {
  operationGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { Job } from '../../printer/job.js';
import type { OperationContext } from '../dispatcher.js';

/**
 * Not-completed job-states (RFC 8011 §5.3.7) — the same active set Get-Jobs uses
 * for `which-jobs=not-completed`. Only these are eligible for Cancel-My-Jobs.
 */
const NOT_COMPLETED_STATES: readonly JobStateValue[] = [
  JobStates.PENDING,
  JobStates.PENDING_HELD,
  JobStates.PROCESSING,
  JobStates.PROCESSING_STOPPED,
] as const;

export function handleCancelMyJobs(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );

  const user = firstString(findAttr(opAttrs, 'requesting-user-name'));
  // Optional `job-ids` (1setOf integer) — restrict the cancel set when present.
  const jobIds = allNumbers(findAttr(opAttrs, 'job-ids'));
  const restrictToIds = jobIds.length > 0 ? new Set(jobIds) : undefined;

  for (const job of ctx.queue.list()) {
    // Only not-completed jobs are eligible; terminal jobs are left as-is.
    if (!NOT_COMPLETED_STATES.includes(job.stateValue)) continue;
    // Ownership: when a user is given, only their jobs; absent → all (fallback).
    if (user !== undefined && job.requestingUserName !== user) continue;
    // job-ids scoping, when supplied.
    if (restrictToIds !== undefined && !restrictToIds.has(job.id)) continue;
    // cancel() returns false only when no CANCEL transition exists — skip those.
    job.cancel();
  }

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
    ],
  };
}

/** Every integer value of an attribute (e.g. a 1setOf integer), in order. */
function allNumbers(attr: IppAttribute | undefined): number[] {
  if (!attr) return [];
  return attr.values
    .map((v) => v.value)
    .filter((v): v is number => typeof v === 'number');
}
