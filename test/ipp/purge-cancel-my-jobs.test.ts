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
  nameWithoutLangAttr,
  integersAttr,
  type IppAttribute,
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

function makeContext(queue: JobQueue): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue,
    printerState: () => PrinterStates.IDLE,
  };
}

function purgeJobsRequest(): IppRequest {
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: OperationIds.PURGE_JOBS,
    requestId: 21,
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

function cancelMyJobsRequest(
  user?: string,
  jobIds?: number[]
): IppRequest {
  const extra: IppAttribute[] = [];
  if (user !== undefined) {
    extra.push(nameWithoutLangAttr('requesting-user-name', user));
  }
  if (jobIds && jobIds.length > 0) {
    extra.push(integersAttr('job-ids', ...jobIds));
  }
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: OperationIds.CANCEL_MY_JOBS,
    requestId: 22,
    groups: [
      operationGroup([
        charsetAttr('attributes-charset', DEFAULT_CHARSET),
        naturalLanguageAttr(
          'attributes-natural-language',
          DEFAULT_NATURAL_LANGUAGE
        ),
        ...extra,
      ]),
    ],
  };
}

function enqueue(queue: JobQueue, name: string, user?: string) {
  return queue.enqueue({
    printerUri: DEFAULT_IDENTITY.uri,
    document: { format: 'application/pdf', bytes: Buffer.from('%PDF') },
    jobName: name,
    requestingUserName: user,
  });
}

describe('Purge-Jobs (0x0012)', () => {
  it('empties the queue entirely — including completed and held jobs', () => {
    const queue = new JobQueue();
    enqueue(queue, 'pending-a'); // pending
    enqueue(queue, 'held-b').hold(); // pending-held
    enqueue(queue, 'done-c').process(); // completed (terminal, retained)
    enqueue(queue, 'killed-d').cancel(); // canceled (terminal, retained)
    expect(queue.size()).toBe(4);

    const response = dispatch(
      decode(encode(purgeJobsRequest())),
      makeContext(queue)
    );

    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(queue.size()).toBe(0);
  });

  it('after a purge Get-Jobs (which-jobs=all) returns no jobs', () => {
    const queue = new JobQueue();
    enqueue(queue, 'a');
    enqueue(queue, 'b').process();

    dispatch(decode(encode(purgeJobsRequest())), makeContext(queue));

    // Get-Jobs with which-jobs=all should now find nothing.
    const getJobs: IppRequest = {
      versionMajor: IPP_VERSION_MAJOR,
      versionMinor: IPP_VERSION_MINOR,
      operationIdOrStatusCode: OperationIds.GET_JOBS,
      requestId: 23,
      groups: [
        operationGroup([
          charsetAttr('attributes-charset', DEFAULT_CHARSET),
          naturalLanguageAttr(
            'attributes-natural-language',
            DEFAULT_NATURAL_LANGUAGE
          ),
          { name: 'which-jobs', values: [{ tag: 0x44, value: 'all' }] },
        ]),
      ],
    };
    const response = dispatch(decode(encode(getJobs)), makeContext(queue));
    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const jobGroups = response.groups.filter(
      (g) => g.tag === DelimiterTags.JOB_ATTRIBUTES
    );
    expect(jobGroups).toHaveLength(0);
  });

  it('is a successful no-op on an empty queue', () => {
    const queue = new JobQueue();
    const response = dispatch(purgeJobsRequest(), makeContext(queue));
    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(queue.size()).toBe(0);
  });
});

describe('Cancel-My-Jobs (0x0039)', () => {
  it("cancels alice's not-completed jobs, leaves bob and alice's completed alone", () => {
    const queue = new JobQueue();
    const aPending = enqueue(queue, 'alice-pending', 'alice'); // not-completed
    const aHeld = enqueue(queue, 'alice-held', 'alice'); // not-completed
    aHeld.hold();
    const aDone = enqueue(queue, 'alice-done', 'alice');
    aDone.process(); // completed (terminal)
    const bPending = enqueue(queue, 'bob-pending', 'bob'); // not-completed

    const response = dispatch(
      decode(encode(cancelMyJobsRequest('alice'))),
      makeContext(queue)
    );

    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    // alice's not-completed jobs are now canceled.
    expect(aPending.stateValue).toBe(JobStates.CANCELED);
    expect(aHeld.stateValue).toBe(JobStates.CANCELED);
    // alice's already-completed job is untouched.
    expect(aDone.stateValue).toBe(JobStates.COMPLETED);
    // bob's job is untouched.
    expect(bPending.stateValue).toBe(JobStates.PENDING);
  });

  it('with no requesting-user-name cancels all not-completed jobs (fallback)', () => {
    const queue = new JobQueue();
    const a = enqueue(queue, 'a', 'alice');
    const b = enqueue(queue, 'b', 'bob');
    const done = enqueue(queue, 'done', 'carol');
    done.process();

    const response = dispatch(cancelMyJobsRequest(), makeContext(queue));

    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(a.stateValue).toBe(JobStates.CANCELED);
    expect(b.stateValue).toBe(JobStates.CANCELED);
    expect(done.stateValue).toBe(JobStates.COMPLETED); // terminal, untouched
  });

  it('honors job-ids: only the listed owned not-completed jobs are canceled', () => {
    const queue = new JobQueue();
    const a1 = enqueue(queue, 'alice-1', 'alice');
    const a2 = enqueue(queue, 'alice-2', 'alice');

    const response = dispatch(
      cancelMyJobsRequest('alice', [a1.id]),
      makeContext(queue)
    );

    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(a1.stateValue).toBe(JobStates.CANCELED);
    expect(a2.stateValue).toBe(JobStates.PENDING); // not in job-ids, untouched
  });
});
