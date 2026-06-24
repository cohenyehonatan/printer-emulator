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
  mimeMediaTypeAttr,
  nameWithoutLangAttr,
  findAttr,
  firstNumber,
  firstString,
  allStrings,
  type IppAttribute,
} from '../../src/ipp/attribute.js';
import {
  operationGroup,
  jobGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../../src/ipp/message.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import { dispatch, type OperationContext } from '../../src/ipp/dispatcher.js';
import { JobQueue } from '../../src/printer/job-queue.js';
import { DEFAULT_IDENTITY } from '../../src/printer/printer-attributes.js';
import { IppPrinter } from '../../src/printer/ipp-printer.js';

const PDF = Buffer.from('%PDF-1.4');

function makeContext(queue: JobQueue): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue,
    printerState: () => PrinterStates.IDLE,
  };
}

/**
 * Build an IPP request. `jobAttrs`, when present, become a trailing
 * job-attributes group — `job-hold-until` is a Job Template attribute on
 * Print-Job/Create-Job.
 */
function request(
  operationId: number,
  extraOpAttrs: IppAttribute[] = [],
  jobAttrs: IppAttribute[] = [],
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
      ...(jobAttrs.length > 0 ? [jobGroup(jobAttrs)] : []),
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

function printerAttrsOf(res: IppResponse): IppAttribute[] {
  return getGroupAttributes(res, DelimiterTags.PRINTER_ATTRIBUTES);
}

describe('job-hold-until (RFC 8011 §5.2.2)', () => {
  it('Print-Job job-hold-until=indefinite -> pending-held, NOT run; reasons include job-hold-until-specified; echoed', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [keywordAttr('job-hold-until', 'indefinite')],
        PDF
      ),
      ctx
    );
    expect(printed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;

    // Held, not run.
    expect(firstNumber(findAttr(jobAttrsOf(printed), 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );
    expect(queue.get(jobId)!.stateValue).toBe(JobStates.PENDING_HELD);

    // Get-Job-Attributes echoes job-hold-until + the job-hold-until-specified
    // reason while held.
    const ja = roundTrip(
      request(OperationIds.GET_JOB_ATTRIBUTES, [integerAttr('job-id', jobId)]),
      ctx
    );
    expect(firstString(findAttr(jobAttrsOf(ja), 'job-hold-until'))).toBe(
      'indefinite'
    );
    expect(allStrings(findAttr(jobAttrsOf(ja), 'job-state-reasons'))).toContain(
      'job-hold-until-specified'
    );

    // Release-Job runs it to completion.
    const released = roundTrip(
      request(OperationIds.RELEASE_JOB, [integerAttr('job-id', jobId)]),
      ctx
    );
    expect(released.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(released), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
    expect(queue.get(jobId)!.stateValue).toBe(JobStates.COMPLETED);
  });

  it('Print-Job job-hold-until=no-hold -> runs to completed immediately', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [keywordAttr('job-hold-until', 'no-hold')],
        PDF
      ),
      ctx
    );
    expect(printed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(printed), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
  });

  it('Print-Job with no job-hold-until still completes (no regression)', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [],
        PDF
      ),
      ctx
    );
    expect(firstNumber(findAttr(jobAttrsOf(printed), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
  });

  it('Hold-Job job-hold-until=no-hold on a held job releases it (per RFC §4.3.5)', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    // Start a held job via Print-Job(indefinite).
    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [keywordAttr('job-hold-until', 'indefinite')],
        PDF
      ),
      ctx
    );
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;
    expect(queue.get(jobId)!.stateValue).toBe(JobStates.PENDING_HELD);

    // Hold-Job with no-hold releases (and runs) it.
    const released = roundTrip(
      request(OperationIds.HOLD_JOB, [
        integerAttr('job-id', jobId),
        keywordAttr('job-hold-until', 'no-hold'),
      ]),
      ctx
    );
    expect(released.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(released), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
    expect(queue.get(jobId)!.stateValue).toBe(JobStates.COMPLETED);
  });

  it('Hold-Job with a holding job-hold-until holds a pending job and records the value', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const job = queue.enqueue({
      printerUri: DEFAULT_IDENTITY.uri,
      document: { format: 'application/pdf', bytes: PDF },
    });
    expect(job.stateValue).toBe(JobStates.PENDING);

    const held = roundTrip(
      request(OperationIds.HOLD_JOB, [
        integerAttr('job-id', job.id),
        keywordAttr('job-hold-until', 'weekend'),
      ]),
      ctx
    );
    expect(held.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(held), 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );
    expect(firstString(findAttr(jobAttrsOf(held), 'job-hold-until'))).toBe(
      'weekend'
    );
  });

  it('Print-Job with an unrecognized job-hold-until value is held without error', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [keywordAttr('job-hold-until', 'made-up-window')],
        PDF
      ),
      ctx
    );
    expect(printed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(printed), 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );
    expect(firstString(findAttr(jobAttrsOf(printed), 'job-hold-until'))).toBe(
      'made-up-window'
    );
  });

  it('named time value (third-shift) holds until explicit Release-Job (no timer auto-fire)', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [keywordAttr('job-hold-until', 'third-shift')],
        PDF
      ),
      ctx
    );
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;
    // Held synchronously; nothing auto-releases it.
    expect(queue.get(jobId)!.stateValue).toBe(JobStates.PENDING_HELD);

    const released = roundTrip(
      request(OperationIds.RELEASE_JOB, [integerAttr('job-id', jobId)]),
      ctx
    );
    expect(firstNumber(findAttr(jobAttrsOf(released), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
  });

  it('Get-Printer-Attributes advertises job-hold-until-supported + job-hold-until-default=no-hold', () => {
    const printer = new IppPrinter({
      port: 0,
      advertise: false,
      logLevel: 'error',
    });
    const res = decode(
      printer.handleRequest(
        encode(
          request(OperationIds.GET_PRINTER_ATTRIBUTES, [
            keywordAttr('requested-attributes', 'all'),
          ])
        )
      )
    );
    const pa = printerAttrsOf(res);
    const supported = allStrings(findAttr(pa, 'job-hold-until-supported'));
    expect(supported).toContain('no-hold');
    expect(supported).toContain('indefinite');
    expect(supported).toContain('weekend');
    expect(firstString(findAttr(pa, 'job-hold-until-default'))).toBe('no-hold');
  });

  it('end-to-end via IppPrinter: Print-Job(indefinite) is held, Release-Job completes it', () => {
    const printer = new IppPrinter({
      port: 0,
      advertise: false,
      logLevel: 'error',
    });

    const printed = decode(
      printer.handleRequest(
        encode(
          request(
            OperationIds.PRINT_JOB,
            [
              nameWithoutLangAttr('job-name', 'held'),
              mimeMediaTypeAttr('document-format', 'application/pdf'),
            ],
            [keywordAttr('job-hold-until', 'indefinite')],
            PDF
          )
        )
      )
    );
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;
    expect(firstNumber(findAttr(jobAttrsOf(printed), 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );

    const released = decode(
      printer.handleRequest(
        encode(
          request(OperationIds.RELEASE_JOB, [integerAttr('job-id', jobId)])
        )
      )
    );
    expect(firstNumber(findAttr(jobAttrsOf(released), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
  });
});
