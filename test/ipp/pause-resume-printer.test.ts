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
  allStrings,
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
import { IppPrinter } from '../../src/printer/ipp-printer.js';

/**
 * Drive a request straight through IppPrinter.handleRequest (decode → dispatch
 * → encode) without start()ing the HTTP server or mDNS — exercises the real
 * paused-state/runPendingJobs wiring while keeping the test fully in-process.
 */
function makePrinter(): IppPrinter {
  return new IppPrinter({ port: 0, advertise: false, logLevel: 'error' });
}

function request(
  operationId: number,
  extraOpAttrs: IppAttribute[] = [],
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

/** Round-trip a request through the printer and decode the binary response. */
function send(printer: IppPrinter, req: IppRequest): IppResponse {
  return decode(printer.handleRequest(encode(req)));
}

function printerAttrsOf(res: IppResponse): IppAttribute[] {
  return getGroupAttributes(res, DelimiterTags.PRINTER_ATTRIBUTES);
}

function jobAttrsOf(res: IppResponse): IppAttribute[] {
  return getGroupAttributes(res, DelimiterTags.JOB_ATTRIBUTES);
}

const PDF = Buffer.from('%PDF-1.4');

describe('Pause-Printer (0x0010) / Resume-Printer (0x0011)', () => {
  it('Pause-Printer drives printer-state to stopped + printer-state-reasons paused', () => {
    const printer = makePrinter();

    const paused = send(printer, request(OperationIds.PAUSE_PRINTER));
    expect(paused.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    // The Pause-Printer response itself carries the now-live printer-state.
    expect(
      firstNumber(findAttr(printerAttrsOf(paused), 'printer-state'))
    ).toBe(PrinterStates.STOPPED);

    // Get-Printer-Attributes confirms stopped (5) + paused.
    const attrs = send(
      printer,
      request(OperationIds.GET_PRINTER_ATTRIBUTES, [
        keywordAttr('requested-attributes', 'all'),
      ])
    );
    const pa = printerAttrsOf(attrs);
    expect(firstNumber(findAttr(pa, 'printer-state'))).toBe(
      PrinterStates.STOPPED
    );
    expect(allStrings(findAttr(pa, 'printer-state-reasons'))).toEqual([
      'paused',
    ]);
  });

  it('while paused a Print-Job stays pending and is not run; Resume runs it to completed', () => {
    const printer = makePrinter();
    send(printer, request(OperationIds.PAUSE_PRINTER));

    // Submit a Print-Job while paused — it must be deferred (pending, state 3).
    const printed = send(
      printer,
      request(
        OperationIds.PRINT_JOB,
        [
          nameWithoutLangAttr('job-name', 'deferred'),
          mimeMediaTypeAttr('document-format', 'application/pdf'),
        ],
        PDF
      )
    );
    expect(printed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;
    expect(firstNumber(findAttr(jobAttrsOf(printed), 'job-state'))).toBe(
      JobStates.PENDING
    );

    // Get-Job-Attributes / Get-Jobs confirm the job is still pending.
    const ja = send(
      printer,
      request(OperationIds.GET_JOB_ATTRIBUTES, [integerAttr('job-id', jobId)])
    );
    expect(firstNumber(findAttr(jobAttrsOf(ja), 'job-state'))).toBe(
      JobStates.PENDING
    );

    const jobs = send(
      printer,
      request(OperationIds.GET_JOBS, [keywordAttr('which-jobs', 'all')])
    );
    expect(firstNumber(findAttr(jobAttrsOf(jobs), 'job-state'))).toBe(
      JobStates.PENDING
    );

    // Resume-Printer runs the deferred job to completion and returns idle.
    const resumed = send(printer, request(OperationIds.RESUME_PRINTER));
    expect(resumed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(
      firstNumber(findAttr(printerAttrsOf(resumed), 'printer-state'))
    ).toBe(PrinterStates.IDLE);

    // The job is now completed (9).
    const after = send(
      printer,
      request(OperationIds.GET_JOB_ATTRIBUTES, [integerAttr('job-id', jobId)])
    );
    expect(firstNumber(findAttr(jobAttrsOf(after), 'job-state'))).toBe(
      JobStates.COMPLETED
    );

    // printer-state back to idle with no reasons.
    const attrs = send(
      printer,
      request(OperationIds.GET_PRINTER_ATTRIBUTES, [
        keywordAttr('requested-attributes', 'all'),
      ])
    );
    expect(
      firstNumber(findAttr(printerAttrsOf(attrs), 'printer-state'))
    ).toBe(PrinterStates.IDLE);
    expect(
      allStrings(findAttr(printerAttrsOf(attrs), 'printer-state-reasons'))
    ).toEqual(['none']);
  });

  it('NON-paused Print-Job still completes synchronously (no regression)', () => {
    const printer = makePrinter();
    const printed = send(
      printer,
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        PDF
      )
    );
    expect(printed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(printed), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
  });

  it('Pause-Printer is idempotent', () => {
    const printer = makePrinter();
    const first = send(printer, request(OperationIds.PAUSE_PRINTER));
    const second = send(printer, request(OperationIds.PAUSE_PRINTER));
    expect(first.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(second.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(
      firstNumber(findAttr(printerAttrsOf(second), 'printer-state'))
    ).toBe(PrinterStates.STOPPED);
  });

  it('Resume-Printer when not paused is a successful no-op', () => {
    const printer = makePrinter();
    const resumed = send(printer, request(OperationIds.RESUME_PRINTER));
    expect(resumed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(
      firstNumber(findAttr(printerAttrsOf(resumed), 'printer-state'))
    ).toBe(PrinterStates.IDLE);
  });

  it('deferred multi-document job (Create/Send-last while paused) runs on Resume', () => {
    const printer = makePrinter();
    send(printer, request(OperationIds.PAUSE_PRINTER));

    const created = send(printer, request(OperationIds.CREATE_JOB));
    const jobId = firstNumber(findAttr(jobAttrsOf(created), 'job-id'))!;

    const sent = send(
      printer,
      request(
        OperationIds.SEND_DOCUMENT,
        [
          integerAttr('job-id', jobId),
          mimeMediaTypeAttr('document-format', 'application/pdf'),
          { name: 'last-document', values: [{ tag: 0x22, value: true }] },
        ],
        PDF
      )
    );
    // Released to pending (deferred), not completed, while paused.
    expect(firstNumber(findAttr(jobAttrsOf(sent), 'job-state'))).toBe(
      JobStates.PENDING
    );

    send(printer, request(OperationIds.RESUME_PRINTER));
    const after = send(
      printer,
      request(OperationIds.GET_JOB_ATTRIBUTES, [integerAttr('job-id', jobId)])
    );
    expect(firstNumber(findAttr(jobAttrsOf(after), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
  });
});

describe('Identify-Printer (0x003C)', () => {
  it('returns successful-ok with identify-actions', () => {
    const printer = makePrinter();
    const res = send(
      printer,
      request(OperationIds.IDENTIFY_PRINTER, [
        keywordAttr('identify-actions', 'flash'),
      ])
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
  });

  it('returns successful-ok without identify-actions (falls back to default)', () => {
    const printer = makePrinter();
    const res = send(printer, request(OperationIds.IDENTIFY_PRINTER));
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
  });

  it('advertises identify-actions-supported in Get-Printer-Attributes', () => {
    const printer = makePrinter();
    const attrs = send(
      printer,
      request(OperationIds.GET_PRINTER_ATTRIBUTES, [
        keywordAttr('requested-attributes', 'all'),
      ])
    );
    const supported = allStrings(
      findAttr(printerAttrsOf(attrs), 'identify-actions-supported')
    );
    expect(supported).toContain('flash');
    expect(supported).toContain('sound');
  });
});
