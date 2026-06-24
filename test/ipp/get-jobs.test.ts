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
  keywordAttr,
  findAttr,
  firstNumber,
} from '../../src/ipp/attribute.js';
import {
  operationGroup,
  type IppRequest,
  type IppAttributeGroup,
} from '../../src/ipp/message.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import { dispatch, type OperationContext } from '../../src/ipp/dispatcher.js';
import { JobQueue } from '../../src/printer/job-queue.js';
import { DEFAULT_IDENTITY } from '../../src/printer/printer-attributes.js';

/** Build a Get-Jobs request with optional which-jobs / limit operation attrs. */
function getJobsRequest(opts: {
  whichJobs?: string;
  limit?: number;
}): IppRequest {
  const extra = [];
  if (opts.whichJobs !== undefined) {
    extra.push(keywordAttr('which-jobs', opts.whichJobs));
  }
  if (opts.limit !== undefined) {
    extra.push(integerAttr('limit', opts.limit));
  }
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: OperationIds.GET_JOBS,
    requestId: 7,
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

function makeContext(queue: JobQueue): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue,
    printerState: () => PrinterStates.IDLE,
  };
}

/** Enqueue 4 jobs: 2 pending, 1 completed, 1 canceled. */
function seedMixedQueue(): JobQueue {
  const queue = new JobQueue();
  const mk = (name: string) =>
    queue.enqueue({
      printerUri: DEFAULT_IDENTITY.uri,
      document: { format: 'application/pdf', bytes: Buffer.from('%PDF') },
      jobName: name,
    });

  mk('pending-a'); // job 1 — pending
  mk('pending-b'); // job 2 — pending
  mk('done').process(); // job 3 — completed
  mk('killed').cancel(); // job 4 — canceled
  return queue;
}

/** All job-attributes groups in the response, in wire order. */
function jobGroupsOf(response: { groups: IppAttributeGroup[] }) {
  return response.groups.filter(
    (g) => g.tag === DelimiterTags.JOB_ATTRIBUTES
  );
}

describe('Get-Jobs (0x000A)', () => {
  it('which-jobs=not-completed returns only pending/processing jobs', () => {
    const queue = seedMixedQueue();
    const response = dispatch(
      decode(encode(getJobsRequest({ whichJobs: 'not-completed' }))),
      makeContext(queue)
    );

    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const groups = jobGroupsOf(response);
    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => firstNumber(findAttr(g.attributes, 'job-id')));
    expect(ids).toEqual([1, 2]); // stable job-id order
    for (const g of groups) {
      expect(firstNumber(findAttr(g.attributes, 'job-state'))).toBe(
        JobStates.PENDING
      );
    }
  });

  it('which-jobs=completed returns completed/canceled/aborted jobs', () => {
    const queue = seedMixedQueue();
    const response = dispatch(
      getJobsRequest({ whichJobs: 'completed' }),
      makeContext(queue)
    );
    const groups = jobGroupsOf(response);
    const ids = groups
      .map((g) => firstNumber(findAttr(g.attributes, 'job-id')))
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(ids).toEqual([3, 4]);
  });

  it('defaults to not-completed when which-jobs is absent', () => {
    const queue = seedMixedQueue();
    const response = dispatch(
      getJobsRequest({}),
      makeContext(queue)
    );
    expect(jobGroupsOf(response)).toHaveLength(2);
  });

  it('which-jobs=all returns every job', () => {
    const queue = seedMixedQueue();
    const response = dispatch(
      getJobsRequest({ whichJobs: 'all' }),
      makeContext(queue)
    );
    expect(jobGroupsOf(response)).toHaveLength(4);
  });

  it('limit caps the number of returned job groups', () => {
    const queue = seedMixedQueue();
    const response = dispatch(
      getJobsRequest({ whichJobs: 'all', limit: 2 }),
      makeContext(queue)
    );
    const groups = jobGroupsOf(response);
    expect(groups).toHaveLength(2);
    // limit keeps the lowest job-ids (stable order).
    const ids = groups.map((g) => firstNumber(findAttr(g.attributes, 'job-id')));
    expect(ids).toEqual([1, 2]);
  });

  it('returns successful-ok with no job groups when nothing matches', () => {
    const queue = new JobQueue();
    const response = dispatch(
      getJobsRequest({ whichJobs: 'completed' }),
      makeContext(queue)
    );
    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(jobGroupsOf(response)).toHaveLength(0);
  });
});
