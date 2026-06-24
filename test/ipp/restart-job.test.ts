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
  type IppAttribute,
} from '../../src/ipp/attribute.js';
import {
  operationGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../../src/ipp/message.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import { dispatch, type OperationContext } from '../../src/ipp/dispatcher.js';
import { JobQueue } from '../../src/printer/job-queue.js';
import { DEFAULT_IDENTITY } from '../../src/printer/printer-attributes.js';

function makeContext(queue: JobQueue): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue,
    printerState: () => PrinterStates.IDLE,
  };
}

function request(
  operationId: number,
  extraOpAttrs: IppAttribute[]
): IppRequest {
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: operationId,
    requestId: 1,
    groups: [
      operationGroup([
        charsetAttr('attributes-charset', DEFAULT_CHARSET),
        naturalLanguageAttr(
          'attributes-natural-language',
          DEFAULT_NATURAL_LANGUAGE
        ),
        ...extraOpAttrs,
      ]),
    ],
  };
}

/** Dispatch a request through a full encode->decode wire round trip. */
function roundTrip(req: IppRequest, ctx: OperationContext): IppResponse {
  return dispatch(decode(encode(req)), ctx);
}

function jobAttrsOf(response: IppResponse): IppAttribute[] {
  return getGroupAttributes(
    decode(encode(response)),
    DelimiterTags.JOB_ATTRIBUTES
  );
}

/** Enqueue a single-shot (closed, pending) job — the Print-Job shape. */
function enqueuePending(queue: JobQueue, name = 'pending') {
  return queue.enqueue({
    printerUri: DEFAULT_IDENTITY.uri,
    document: { format: 'application/pdf', bytes: Buffer.from('%PDF') },
    jobName: name,
  });
}

describe('Restart-Job (0x000E)', () => {
  it('completed job -> Restart-Job -> runs again to completed (fresh run)', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const job = enqueuePending(queue, 'restart-me');

    // Drive the job to completed (terminal/retained).
    job.process();
    expect(job.stateValue).toBe(JobStates.COMPLETED);
    expect(job.runs).toBe(1);

    const res = roundTrip(
      request(OperationIds.RESTART_JOB, [integerAttr('job-id', job.id)]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    // It re-ran all the way to completed again...
    expect(firstNumber(findAttr(jobAttrsOf(res), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
    expect(job.stateValue).toBe(JobStates.COMPLETED);
    // ...and the second completion is observable: it actually re-processed.
    expect(job.runs).toBe(2);
  });

  it('a restarted job is left pending while the printer is paused (deferred re-run)', () => {
    const queue = new JobQueue();
    const ctx: OperationContext = {
      ...makeContext(queue),
      isPaused: () => true,
    };
    const job = enqueuePending(queue, 'paused-restart');
    job.process(); // completed
    expect(job.runs).toBe(1);

    const res = roundTrip(
      request(OperationIds.RESTART_JOB, [integerAttr('job-id', job.id)]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    // Paused → re-run deferred: job is pending, not completed, and did NOT re-run.
    expect(firstNumber(findAttr(jobAttrsOf(res), 'job-state'))).toBe(
      JobStates.PENDING
    );
    expect(job.stateValue).toBe(JobStates.PENDING);
    expect(job.runs).toBe(1);
  });

  it('a canceled job can be restarted', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const job = enqueuePending(queue, 'canceled');
    expect(job.cancel()).toBe(true);
    expect(job.stateValue).toBe(JobStates.CANCELED);

    const res = roundTrip(
      request(OperationIds.RESTART_JOB, [integerAttr('job-id', job.id)]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(res), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
    expect(job.runs).toBe(1);
  });

  it('Restart-Job on a pending (non-terminal) job returns client-error-not-possible', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const job = enqueuePending(queue, 'still-pending');
    expect(job.stateValue).toBe(JobStates.PENDING);

    const res = roundTrip(
      request(OperationIds.RESTART_JOB, [integerAttr('job-id', job.id)]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_POSSIBLE
    );
    expect(job.stateValue).toBe(JobStates.PENDING); // unchanged
    expect(jobAttrsOf(res)).toHaveLength(0);
  });

  it('Restart-Job on an unknown job-id returns client-error-not-found', () => {
    const queue = new JobQueue();
    const res = roundTrip(
      request(OperationIds.RESTART_JOB, [integerAttr('job-id', 9999)]),
      makeContext(queue)
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.CLIENT_ERROR_NOT_FOUND);
    expect(jobAttrsOf(res)).toHaveLength(0);
  });
});
