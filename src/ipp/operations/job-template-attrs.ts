/**
 * Shared emitter for the common print Job Template attributes on a Job.
 *
 * `print-color-mode`, `print-quality`, `sides`, `orientation-requested`,
 * `media`, and `page-ranges` are echoed by Print-Job/Create-Job,
 * Get-Job-Attributes, Get-Jobs, and Set-Job-Attributes — but only once the
 * client supplied a value (mirroring how `copies` is conditionally emitted).
 * Centralizing the build keeps every response consistent and the value-tags
 * (keyword vs enum vs rangeOfInteger) in one place.
 */

import {
  keywordAttr,
  enumAttr,
  rangesAttr,
  type IppAttribute,
  type IppRange,
} from '../attribute.js';
import type { Job } from '../../printer/job.js';

/**
 * Build the Job Template attribute list for `job`, omitting any the client
 * never set so the default job-attribute set is unchanged for jobs without
 * them. `print-quality`/`orientation-requested` are enums, `page-ranges` is a
 * 1setOf rangeOfInteger, the rest keywords.
 */
export function jobTemplateAttributes(job: Job): IppAttribute[] {
  const attrs: IppAttribute[] = [];
  if (job.printColorMode !== undefined) {
    attrs.push(keywordAttr('print-color-mode', job.printColorMode));
  }
  if (job.printQuality !== undefined) {
    attrs.push(enumAttr('print-quality', job.printQuality));
  }
  if (job.sides !== undefined) {
    attrs.push(keywordAttr('sides', job.sides));
  }
  if (job.orientation !== undefined) {
    attrs.push(enumAttr('orientation-requested', job.orientation));
  }
  if (job.media !== undefined) {
    attrs.push(keywordAttr('media', job.media));
  }
  if (job.pageRanges !== undefined) {
    const ranges: IppRange[] = job.pageRanges.map((r) => [r.lower, r.upper]);
    attrs.push(rangesAttr('page-ranges', ...ranges));
  }
  return attrs;
}
