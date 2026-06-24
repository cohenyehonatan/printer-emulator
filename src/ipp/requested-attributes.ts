/**
 * requested-attributes sub-selection — RFC 8011 §4.2.5.1.
 *
 * Get-* operations may carry a `requested-attributes` operation attribute (a
 * 1setOf keyword) naming which attributes the client wants back. This module
 * resolves that request against a fully-built attribute set and returns only
 * the requested members, preserving the original attribute order.
 *
 * Group keywords are honored as expanding aliases:
 *   - `all` — every attribute (the full set).
 *   - `job-description` / `job-template` — the job-attribute groups.
 *   - `printer-description` — the printer-attribute group.
 * For this emulator the group keywords (other than `all`) expand to the full
 * built set, since each Get-* handler already builds exactly one such group;
 * mixing a group keyword with explicit names yields the union.
 *
 * CRUCIAL back-compat contract: when `requested-attributes` is ABSENT
 * (undefined or empty), the full set is returned UNCHANGED so existing
 * behavior/tests are preserved.
 *
 * Duplicate-attribute coalescing: a non-canonical client may send the request
 * as SEVERAL separate `requested-attributes` attributes (one keyword each)
 * rather than the canonical single 1setOf. We honor the UNION of every
 * `requested-attributes` attribute in the operation group (order-preserving,
 * de-duplicated), so both wire shapes resolve identically.
 */

import { allStrings, type IppAttribute } from './attribute.js';
import { getGroupAttributes, type IppMessage } from './message.js';
import { DelimiterTags } from './constants.js';

/** Group keywords that expand to "the whole built set" for this emulator. */
const GROUP_KEYWORDS = new Set([
  'all',
  'job-description',
  'job-template',
  'printer-description',
]);

/**
 * Read the requested-attributes keyword list from a request's
 * operation-attributes group. Returns undefined when the attribute is absent
 * (the back-compat signal: emit everything).
 *
 * Collects the values of EVERY attribute named `requested-attributes` in the
 * operation group, not just the first — a client that (non-canonically) sends
 * the names as multiple separate `requested-attributes` attributes is honored
 * as the union of all of them. The canonical single-1setOf shape is the
 * one-attribute case of the same logic, so it is unchanged. The union preserves
 * first-seen order and drops duplicates.
 */
export function readRequestedAttributes(
  request: IppMessage
): string[] | undefined {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );

  const seen = new Set<string>();
  const names: string[] = [];
  for (const attr of opAttrs) {
    if (attr.name !== 'requested-attributes') continue;
    for (const name of allStrings(attr)) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }

  return names.length > 0 ? names : undefined;
}

/**
 * Filter a fully-built attribute set down to those named in `requested`.
 *
 * - `requested` undefined/empty → return `full` unchanged (back-compat).
 * - any group keyword present (`all`, `printer-description`, ...) → return
 *   `full` unchanged (whole set requested).
 * - otherwise → keep only attributes whose name is in `requested`, preserving
 *   `full`'s original order.
 */
export function selectAttributes(
  full: IppAttribute[],
  requested: string[] | undefined
): IppAttribute[] {
  if (!requested || requested.length === 0) return full;
  if (requested.some((name) => GROUP_KEYWORDS.has(name))) return full;

  const wanted = new Set(requested);
  return full.filter((attr) => wanted.has(attr.name));
}

/** Convenience: read the request's requested-attributes and apply them. */
export function applyRequestedAttributes(
  request: IppMessage,
  full: IppAttribute[]
): IppAttribute[] {
  return selectAttributes(full, readRequestedAttributes(request));
}
