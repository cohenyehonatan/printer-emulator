/**
 * Print-PDF scenario.
 *
 * Validates then submits a tiny fake PDF byte blob via Print-Job, asserting
 * successful-ok and that a job-id comes back. Exercises the full client ->
 * HTTP -> dispatcher -> queue -> response path for the core print operation.
 */

import {
  StatusCodes,
  DelimiterTags,
} from '../../ipp/constants.js';
import { getGroupAttributes } from '../../ipp/message.js';
import { findAttr, firstNumber } from '../../ipp/attribute.js';
import { Mime } from '../../documents/formats.js';
import type { Scenario } from './scenario.js';

// Minimal but format-detectable PDF byte blob.
const FAKE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'ascii'
);

export const printPdfScenario: Scenario = {
  name: 'Print PDF',
  description: 'Validate-Job then Print-Job with a fake PDF blob',
  steps: [
    {
      name: 'Validate-Job returns successful-ok',
      run: async (client) => {
        const res = await client.validateJob(Mime.PDF);
        if (res.operationIdOrStatusCode !== StatusCodes.SUCCESSFUL_OK) {
          throw new Error(
            `expected successful-ok, got 0x${res.operationIdOrStatusCode.toString(16)}`
          );
        }
      },
    },
    {
      name: 'Print-Job returns successful-ok with a job-id',
      run: async (client) => {
        const res = await client.printJob(FAKE_PDF, Mime.PDF, 'fake.pdf');
        if (res.operationIdOrStatusCode !== StatusCodes.SUCCESSFUL_OK) {
          throw new Error(
            `expected successful-ok, got 0x${res.operationIdOrStatusCode.toString(16)}`
          );
        }
        const jobAttrs = getGroupAttributes(res, DelimiterTags.JOB_ATTRIBUTES);
        const jobId = firstNumber(findAttr(jobAttrs, 'job-id'));
        if (jobId === undefined) {
          throw new Error('response missing job-id');
        }
      },
    },
  ],
};
