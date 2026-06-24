/**
 * `job-hold-until` parsing + policy — RFC 8011 §5.2.2.
 *
 * `job-hold-until` is a Job Template attribute (type2 keyword | name) that tells
 * the printer whether — and when — to hold a job rather than print it. Clients
 * may send it in the job-attributes group of Print-Job/Create-Job, or as an
 * operation attribute of Hold-Job (§4.3.5). This module reads it from either
 * group and classifies it into the single decision the emulator cares about:
 * "should this job be held?".
 *
 * Value mapping (RFC 8011 §5.2.2):
 *   - `no-hold`     → NOT held; the job runs normally (subject to the existing
 *                     paused-deferral logic).
 *   - `indefinite`  → held as `pending-held` until an explicit Release-Job.
 *   - `day-time`, `evening`, `night`, `weekend`, `second-shift`, `third-shift`
 *                   → named wall-clock release windows. A full implementation
 *                     auto-releases when that window arrives; this emulator has
 *                     NO wall-clock release policy, so they are treated as
 *                     held-until-explicit-Release-Job (RFC-acceptable for an
 *                     emulator — see README). No timer is armed.
 *   - any unrecognized keyword → held (defaults to `indefinite` behavior),
 *                     never an error.
 *
 * Nothing here throws on malformed protocol input.
 */

import { JobHoldUntil } from './constants.js';
import { firstString, findAttr, type IppAttribute } from './attribute.js';

/**
 * Whether a given `job-hold-until` value means "hold the job". `no-hold` (and
 * the absence sentinel handled by the caller) is the only non-holding value;
 * every other keyword — recognized time value or not — holds the job.
 */
export function holdUntilHolds(value: string | undefined): boolean {
  return value !== undefined && value !== JobHoldUntil.NO_HOLD;
}

/**
 * Read the `job-hold-until` keyword from a request's attributes. Looks in the
 * operation-attributes group first (where Hold-Job carries it) then the
 * job-attributes group (where Print-Job/Create-Job carry it as a Job Template
 * attribute). Returns undefined when the client sent no `job-hold-until`.
 */
export function readJobHoldUntil(
  opAttrs: IppAttribute[],
  jobAttrs: IppAttribute[]
): string | undefined {
  return (
    firstString(findAttr(opAttrs, 'job-hold-until')) ??
    firstString(findAttr(jobAttrs, 'job-hold-until'))
  );
}
