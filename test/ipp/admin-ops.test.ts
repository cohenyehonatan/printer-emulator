import { describe, it, expect } from 'vitest';
import {
  OperationIds,
  StatusCodes,
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
  keywordAttr,
  mimeMediaTypeAttr,
  findAttr,
  firstString,
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

/** Mutable printer state the admin hooks drive, mirroring IppPrinter. */
function makeState() {
  return { accepting: true, holdingNewJobs: false, paused: false };
}

function makeContext(
  queue: JobQueue,
  state: ReturnType<typeof makeState>
): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue,
    printerState: () =>
      state.paused ? PrinterStates.STOPPED : PrinterStates.IDLE,
    printerStateReasons: () =>
      state.holdingNewJobs ? ['hold-new-jobs'] : ['none'],
    isAcceptingJobs: () => state.accepting,
    enablePrinter: () => {
      state.accepting = true;
    },
    disablePrinter: () => {
      state.accepting = false;
    },
    isHoldingNewJobs: () => state.holdingNewJobs,
    holdNewJobs: () => {
      state.holdingNewJobs = true;
    },
    releaseHeldNewJobs: () => {
      state.holdingNewJobs = false;
    },
    pausePrinterAfterCurrentJob: () => {
      state.paused = true;
    },
    restartPrinter: () => {
      state.accepting = true;
      state.holdingNewJobs = false;
      state.paused = false;
    },
  };
}

function request(operationId: number, extra: IppAttribute[] = []): IppRequest {
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
        ...extra,
      ]),
    ],
  };
}

function roundTrip(req: IppRequest, ctx: OperationContext): IppResponse {
  return dispatch(decode(encode(req)), ctx);
}

function printerAttr(res: IppResponse, name: string): IppAttribute | undefined {
  const group = getGroupAttributes(
    decode(encode(res)),
    DelimiterTags.PRINTER_ATTRIBUTES
  );
  return findAttr(group, name);
}

function printJobRequest(): IppRequest {
  return request(OperationIds.PRINT_JOB, [
    mimeMediaTypeAttr('document-format', 'text/plain'),
  ]);
}

describe('IPP admin operations (RFC 3998)', () => {
  it('advertises the new admin op-ids in operations-supported', () => {
    const ctx = makeContext(new JobQueue(), makeState());
    const res = roundTrip(request(OperationIds.GET_PRINTER_ATTRIBUTES), ctx);
    const ops = printerAttr(res, 'operations-supported');
    const ids = ops?.values.map((v) => v.value) ?? [];
    for (const id of [
      OperationIds.ENABLE_PRINTER,
      OperationIds.DISABLE_PRINTER,
      OperationIds.PAUSE_PRINTER_AFTER_CURRENT_JOB,
      OperationIds.HOLD_NEW_JOBS,
      OperationIds.RELEASE_HELD_NEW_JOBS,
      OperationIds.RESTART_PRINTER,
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('Disable-Printer flips printer-is-accepting-jobs to false', () => {
    const state = makeState();
    const ctx = makeContext(new JobQueue(), state);
    expect(
      roundTrip(request(OperationIds.DISABLE_PRINTER), ctx)
        .operationIdOrStatusCode
    ).toBe(StatusCodes.SUCCESSFUL_OK);
    const res = roundTrip(request(OperationIds.GET_PRINTER_ATTRIBUTES), ctx);
    expect(printerAttr(res, 'printer-is-accepting-jobs')?.values[0].value).toBe(
      false
    );
  });

  it('Print-Job is rejected with not-accepting-jobs (0x0506) while disabled', () => {
    const state = makeState();
    const ctx = makeContext(new JobQueue(), state);
    roundTrip(request(OperationIds.DISABLE_PRINTER), ctx);
    const res = roundTrip(printJobRequest(), ctx);
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.SERVER_ERROR_NOT_ACCEPTING_JOBS
    );
    expect(StatusCodes.SERVER_ERROR_NOT_ACCEPTING_JOBS).toBe(0x0506);
  });

  it('Enable-Printer restores job acceptance', () => {
    const state = makeState();
    const ctx = makeContext(new JobQueue(), state);
    roundTrip(request(OperationIds.DISABLE_PRINTER), ctx);
    roundTrip(request(OperationIds.ENABLE_PRINTER), ctx);
    const res = roundTrip(printJobRequest(), ctx);
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(
      printerAttr(
        roundTrip(request(OperationIds.GET_PRINTER_ATTRIBUTES), ctx),
        'printer-is-accepting-jobs'
      )?.values[0].value
    ).toBe(true);
  });

  it('Hold-New-Jobs sets the hold-new-jobs state-reason; Release clears it', () => {
    const state = makeState();
    const ctx = makeContext(new JobQueue(), state);
    roundTrip(request(OperationIds.HOLD_NEW_JOBS), ctx);
    expect(state.holdingNewJobs).toBe(true);
    let reasons = printerAttr(
      roundTrip(request(OperationIds.GET_PRINTER_ATTRIBUTES), ctx),
      'printer-state-reasons'
    );
    expect(reasons?.values.map((v) => v.value)).toContain('hold-new-jobs');

    roundTrip(request(OperationIds.RELEASE_HELD_NEW_JOBS), ctx);
    expect(state.holdingNewJobs).toBe(false);
    reasons = printerAttr(
      roundTrip(request(OperationIds.GET_PRINTER_ATTRIBUTES), ctx),
      'printer-state-reasons'
    );
    expect(reasons?.values.map((v) => v.value)).not.toContain('hold-new-jobs');
  });

  it('Restart-Printer resets to accepting + not holding', () => {
    const state = makeState();
    const ctx = makeContext(new JobQueue(), state);
    roundTrip(request(OperationIds.DISABLE_PRINTER), ctx);
    roundTrip(request(OperationIds.HOLD_NEW_JOBS), ctx);
    expect(
      roundTrip(request(OperationIds.RESTART_PRINTER), ctx)
        .operationIdOrStatusCode
    ).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(state.accepting).toBe(true);
    expect(state.holdingNewJobs).toBe(false);
  });
});
