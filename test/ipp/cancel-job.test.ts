import { describe, it, expect } from 'vitest';
import {
  OperationIds,
  StatusCodes,
  JobStates,
  PrinterStates,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
} from '../../src/ipp/constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  integerAttr,
} from '../../src/ipp/attribute.js';
import {
  operationGroup,
  type IppRequest,
} from '../../src/ipp/message.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import { dispatch, type OperationContext } from '../../src/ipp/dispatcher.js';
import { JobQueue } from '../../src/printer/job-queue.js';
import { DEFAULT_IDENTITY } from '../../src/printer/printer-attributes.js';

function cancelJobRequest(jobId: number): IppRequest {
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: OperationIds.CANCEL_JOB,
    requestId: 11,
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

function enqueueJob(queue: JobQueue, name: string) {
  return queue.enqueue({
    printerUri: DEFAULT_IDENTITY.uri,
    document: { format: 'application/pdf', bytes: Buffer.from('%PDF') },
    jobName: name,
  });
}

describe('Cancel-Job (0x0008)', () => {
  it('cancels a pending job: successful-ok and job becomes canceled', () => {
    const queue = new JobQueue();
    const job = enqueueJob(queue, 'pending');

    const response = dispatch(
      decode(encode(cancelJobRequest(job.id))),
      makeContext(queue)
    );

    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(job.stateValue).toBe(JobStates.CANCELED);
  });

  it('rejects cancelling an already-completed job with client-error-not-possible', () => {
    const queue = new JobQueue();
    const job = enqueueJob(queue, 'done');
    job.process(); // drive to completed (terminal)

    const response = dispatch(cancelJobRequest(job.id), makeContext(queue));

    expect(response.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_POSSIBLE
    );
    expect(job.stateValue).toBe(JobStates.COMPLETED); // unchanged
  });

  it('rejects cancelling an already-canceled job with client-error-not-possible', () => {
    const queue = new JobQueue();
    const job = enqueueJob(queue, 'killed');
    job.cancel(); // already terminal

    const response = dispatch(cancelJobRequest(job.id), makeContext(queue));

    expect(response.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_POSSIBLE
    );
    expect(job.stateValue).toBe(JobStates.CANCELED);
  });

  it('returns client-error-not-found for an unknown job-id', () => {
    const queue = new JobQueue();
    const response = dispatch(cancelJobRequest(9999), makeContext(queue));
    expect(response.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_FOUND
    );
  });
});
