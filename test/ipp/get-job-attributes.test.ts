import { describe, it, expect } from 'vitest';
import {
  OperationIds,
  StatusCodes,
  JobStates,
  PrinterStates,
  DelimiterTags,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
} from '../../src/ipp/constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  integerAttr,
  findAttr,
  firstNumber,
} from '../../src/ipp/attribute.js';
import {
  operationGroup,
  getGroupAttributes,
  type IppRequest,
} from '../../src/ipp/message.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import { dispatch, type OperationContext } from '../../src/ipp/dispatcher.js';
import { JobQueue } from '../../src/printer/job-queue.js';
import { DEFAULT_IDENTITY } from '../../src/printer/printer-attributes.js';

/** Build a Get-Job-Attributes request carrying a job-id operation attribute. */
function getJobAttributesRequest(jobId: number): IppRequest {
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: OperationIds.GET_JOB_ATTRIBUTES,
    requestId: 42,
    groups: [
      operationGroup([
        charsetAttr('attributes-charset', DEFAULT_CHARSET),
        naturalLanguageAttr(
          'attributes-natural-language',
          DEFAULT_NATURAL_LANGUAGE
        ),
        integerAttr('job-id', jobId),
      ]),
    ],
  };
}

function makeContext(queue: JobQueue): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue,
    printerState: () => PrinterStates.IDLE,
  };
}

describe('Get-Job-Attributes (0x0009)', () => {
  it('returns the queued job state + id, surviving an encode->decode round trip', () => {
    const queue = new JobQueue();
    const job = queue.enqueue({
      printerUri: DEFAULT_IDENTITY.uri,
      document: { format: 'application/pdf', bytes: Buffer.from('%PDF-1.4') },
      jobName: 'unit-test-job',
      requestingUserName: 'tester',
    });
    job.process(); // drive to completed

    // Round-trip the request through the wire codec, then dispatch.
    const request = decode(encode(getJobAttributesRequest(job.id)));
    const response = dispatch(request, makeContext(queue));

    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const jobAttrs = getGroupAttributes(
      // re-encode/decode the response too, proving full wire fidelity
      decode(encode(response)),
      DelimiterTags.JOB_ATTRIBUTES
    );

    expect(firstNumber(findAttr(jobAttrs, 'job-id'))).toBe(job.id);
    expect(firstNumber(findAttr(jobAttrs, 'job-state'))).toBe(
      JobStates.COMPLETED
    );
    expect(findAttr(jobAttrs, 'job-name')).toBeDefined();
    expect(findAttr(jobAttrs, 'job-uri')).toBeDefined();
    expect(findAttr(jobAttrs, 'job-state-reasons')).toBeDefined();
    expect(findAttr(jobAttrs, 'job-originating-user-name')).toBeDefined();
  });

  it('returns client-error-not-found for an unknown job-id', () => {
    const queue = new JobQueue();
    const request = getJobAttributesRequest(9999);
    const response = dispatch(request, makeContext(queue));

    expect(response.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_FOUND
    );
    // No job-attributes group on the error path.
    expect(
      getGroupAttributes(response, DelimiterTags.JOB_ATTRIBUTES)
    ).toHaveLength(0);
  });
});
