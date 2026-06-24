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
  booleanAttr,
  mimeMediaTypeAttr,
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
  extraOpAttrs: IppAttribute[],
  data?: Buffer
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
    data,
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

describe('Hold-Job (0x000C) / Release-Job (0x000D)', () => {
  it('pending job -> Hold-Job -> pending-held -> Release-Job -> completed', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const job = enqueuePending(queue);
    expect(job.stateValue).toBe(JobStates.PENDING);

    // Hold-Job drives the pending job to pending-held.
    const held = roundTrip(
      request(OperationIds.HOLD_JOB, [integerAttr('job-id', job.id)]),
      ctx
    );
    expect(held.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(held), 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );
    expect(job.stateValue).toBe(JobStates.PENDING_HELD);

    // Release-Job releases it and runs the emulated print to completion.
    const released = roundTrip(
      request(OperationIds.RELEASE_JOB, [integerAttr('job-id', job.id)]),
      ctx
    );
    expect(released.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(released), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
    expect(job.stateValue).toBe(JobStates.COMPLETED);
  });

  it('Hold-Job on a Create-Job job keeps it pending-held and Send-Document(last) still completes', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const created = roundTrip(request(OperationIds.CREATE_JOB, []), ctx);
    const jobId = firstNumber(findAttr(jobAttrsOf(created), 'job-id'))!;
    expect(queue.get(jobId)!.stateValue).toBe(JobStates.PENDING_HELD);

    // Hold-Job on an already-held open job is an idempotent success.
    const held = roundTrip(
      request(OperationIds.HOLD_JOB, [integerAttr('job-id', jobId)]),
      ctx
    );
    expect(held.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(held), 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );

    // Send-Document(last=true) still releases and completes the job normally.
    const sent = roundTrip(
      request(
        OperationIds.SEND_DOCUMENT,
        [
          integerAttr('job-id', jobId),
          mimeMediaTypeAttr('document-format', 'application/pdf'),
          booleanAttr('last-document', true),
        ],
        Buffer.from('%PDF-1.4')
      ),
      ctx
    );
    expect(sent.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(sent), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
  });

  it('Release-Job on a not-held (pending) job is a successful no-op that runs it', () => {
    // RFC 8011 §4.3.6: Release-Job clears the held state; on an unheld job it
    // succeeds. Our implementation treats the unheld pending job as runnable.
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const job = enqueuePending(queue, 'never-held');

    const res = roundTrip(
      request(OperationIds.RELEASE_JOB, [integerAttr('job-id', job.id)]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
  });

  it('Hold-Job on an unknown job-id returns client-error-not-found', () => {
    const queue = new JobQueue();
    const res = roundTrip(
      request(OperationIds.HOLD_JOB, [integerAttr('job-id', 9999)]),
      makeContext(queue)
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.CLIENT_ERROR_NOT_FOUND);
    expect(jobAttrsOf(res)).toHaveLength(0);
  });

  it('Release-Job on an unknown job-id returns client-error-not-found', () => {
    const queue = new JobQueue();
    const res = roundTrip(
      request(OperationIds.RELEASE_JOB, [integerAttr('job-id', 9999)]),
      makeContext(queue)
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.CLIENT_ERROR_NOT_FOUND);
    expect(jobAttrsOf(res)).toHaveLength(0);
  });

  it('Hold-Job on an already-completed job returns client-error-not-possible', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const job = enqueuePending(queue, 'done');
    job.process(); // drive to completed (terminal)

    const res = roundTrip(
      request(OperationIds.HOLD_JOB, [integerAttr('job-id', job.id)]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_POSSIBLE
    );
    expect(job.stateValue).toBe(JobStates.COMPLETED); // unchanged
  });

  it('Release-Job on an already-completed job returns client-error-not-possible', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const job = enqueuePending(queue, 'done');
    job.process(); // terminal

    const res = roundTrip(
      request(OperationIds.RELEASE_JOB, [integerAttr('job-id', job.id)]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_POSSIBLE
    );
    expect(job.stateValue).toBe(JobStates.COMPLETED); // unchanged
  });
});
