/**
 * Set-Job-Attributes operation (0x0014) — RFC 3380 §4.2. WORKING.
 *
 * Resolves the target job from `job-id` (or the trailing `/jobs/<id>` of a
 * `job-uri`) and, when the job is NON-terminal (pending / pending-held /
 * processing / processing-stopped), applies the settable job attributes carried
 * in the job-attributes group. The settable set (advertised as
 * `job-settable-attributes-supported`) is:
 *   - `job-name`        (name)        → Job.setJobName
 *   - `job-priority`    (integer)     → Job.setJobPriority (clamped 1–100)
 *   - `copies`          (integer)     → Job.setCopies (≥1)
 *   - `job-hold-until`  (keyword)     → re-holds/releases via the existing
 *                                       hold-until logic (Job.holdWith)
 *   - `print-color-mode`      (keyword) → Job.setPrintColorMode
 *   - `print-quality`         (enum)    → Job.setPrintQuality
 *   - `sides`                 (keyword) → Job.setSides
 *   - `orientation-requested` (enum)    → Job.setOrientation
 *   - `media`                 (keyword) → Job.setMedia
 * Each print Job Template setter clamps/ignores an unadvertised value rather
 * than failing. The applied values are reflected by Get-Job-Attributes / Get-Jobs. Returns
 * successful-ok plus the job-state group; unsettable/unknown attributes are
 * surfaced in an `unsupported-attributes` group rather than failing the op.
 *
 * Errors (never throws):
 *   - client-error-not-found    (0x0406): the job-id is absent or unknown.
 *   - client-error-not-possible (0x0405): the job is in a terminal state
 *     (completed / canceled / aborted), which is not settable (RFC 3380 §4.2).
 *
 * NO-AUTH CAVEAT: a real IPP host gates Set-Job-Attributes behind the job
 * owner's / operator's policy. This emulator has no authentication layer, so it
 * applies the writes unconditionally (see README).
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  DelimiterTags,
  ValueTags,
} from '../constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  integerAttr,
  enumAttr,
  uriAttr,
  keywordAttr,
  firstString,
  firstNumber,
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
import { JOB_SETTABLE_ATTRIBUTES } from '../../printer/job.js';
import { jobTemplateAttributes } from './job-template-attrs.js';
import type { OperationContext } from '../dispatcher.js';

const SETTABLE = new Set<string>(JOB_SETTABLE_ATTRIBUTES);

export function handleSetJobAttributes(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );
  const jobAttrs = getGroupAttributes(request, DelimiterTags.JOB_ATTRIBUTES);

  const jobId =
    firstNumber(findAttr(opAttrs, 'job-id')) ??
    jobIdFromUri(firstString(findAttr(opAttrs, 'job-uri')));

  const job = jobId !== undefined ? ctx.queue.get(jobId) : undefined;
  if (!job) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_FOUND);
  }

  // A terminal job (completed/canceled/aborted) is not a legal target.
  if (!job.isSettable) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_POSSIBLE);
  }

  const unsupported: IppAttribute[] = [];
  for (const attr of jobAttrs) {
    switch (attr.name) {
      case 'job-name':
        job.setJobName(firstString(attr));
        break;
      case 'job-priority':
        job.setJobPriority(firstNumber(attr));
        break;
      case 'copies':
        job.setCopies(firstNumber(attr));
        break;
      case 'print-color-mode':
        job.setPrintColorMode(firstString(attr));
        break;
      case 'print-quality':
        job.setPrintQuality(firstNumber(attr));
        break;
      case 'sides':
        job.setSides(firstString(attr));
        break;
      case 'orientation-requested':
        job.setOrientation(firstNumber(attr));
        break;
      case 'media':
        job.setMedia(firstString(attr));
        break;
      case 'job-hold-until': {
        // Reuse the existing hold-until policy: a holding value re-holds the
        // job, `no-hold` releases (and runs) it. Paused → release is deferred.
        const value = firstString(attr);
        const paused = ctx.isPaused?.() ?? false;
        const released = job.holdWith(value, paused);
        if (released && !paused) ctx.renderRaster?.(job);
        break;
      }
      default:
        if (!SETTABLE.has(attr.name)) {
          unsupported.push({
            name: attr.name,
            values: [{ tag: ValueTags.UNSUPPORTED, value: '' }],
          });
        }
    }
  }

  const jobUri = `${ctx.identity.uri}/jobs/${job.id}`;
  const groups = [
    operationGroup([
      charsetAttr('attributes-charset', DEFAULT_CHARSET),
      naturalLanguageAttr('attributes-natural-language', DEFAULT_NATURAL_LANGUAGE),
    ]),
  ];
  if (unsupported.length > 0) {
    groups.push({
      tag: DelimiterTags.UNSUPPORTED_ATTRIBUTES,
      attributes: unsupported,
    });
  }
  groups.push(
    jobGroup([
      uriAttr('job-uri', jobUri),
      integerAttr('job-id', job.id),
      enumAttr('job-state', job.stateValue),
      ...(job.holdUntil !== undefined
        ? [keywordAttr('job-hold-until', job.holdUntil)]
        : []),
      ...jobTemplateAttributes(job),
    ])
  );

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
    requestId: request.requestId,
    groups,
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
