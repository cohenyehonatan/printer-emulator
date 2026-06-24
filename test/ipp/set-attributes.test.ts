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
  nameWithoutLangAttr,
  textWithoutLangAttr,
  mimeMediaTypeAttr,
  findAttr,
  firstNumber,
  firstString,
  allStrings,
  type IppAttribute,
} from '../../src/ipp/attribute.js';
import {
  operationGroup,
  jobGroup,
  printerGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../../src/ipp/message.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import { IppPrinter } from '../../src/printer/ipp-printer.js';

const PDF = Buffer.from('%PDF-1.4');

/**
 * Build an IPP request. `jobAttrs`/`printerAttrs`, when present, become trailing
 * job-/printer-attributes groups — Set-Job-Attributes carries the new values in
 * a job-attributes group, Set-Printer-Attributes in a printer-attributes group.
 */
function request(
  operationId: number,
  extraOpAttrs: IppAttribute[] = [],
  options: {
    jobAttrs?: IppAttribute[];
    printerAttrs?: IppAttribute[];
    data?: Buffer;
  } = {}
): IppRequest {
  const { jobAttrs = [], printerAttrs = [], data } = options;
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
      ...(printerAttrs.length > 0 ? [printerGroup(printerAttrs)] : []),
    ],
    data,
  };
}

/** Round-trip a request through the IppPrinter's decode->dispatch->encode. */
function send(printer: IppPrinter, req: IppRequest): IppResponse {
  return decode(printer.handleRequest(encode(req)));
}

function printerAttrsOf(res: IppResponse): IppAttribute[] {
  return getGroupAttributes(res, DelimiterTags.PRINTER_ATTRIBUTES);
}

function jobAttrsOf(res: IppResponse): IppAttribute[] {
  return getGroupAttributes(res, DelimiterTags.JOB_ATTRIBUTES);
}

function newPrinter(): IppPrinter {
  return new IppPrinter({ port: 0, advertise: false, logLevel: 'error' });
}

describe('Set-Printer-Attributes (0x0013)', () => {
  it('sets printer-location and printer-info; Get-Printer-Attributes reflects them', () => {
    const printer = newPrinter();

    const set = send(
      printer,
      request(OperationIds.SET_PRINTER_ATTRIBUTES, [], {
        printerAttrs: [
          textWithoutLangAttr('printer-location', 'Lab B, Rack 4'),
          textWithoutLangAttr('printer-info', 'Loaner unit — handle with care'),
        ],
      })
    );
    expect(set.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const got = send(
      printer,
      request(OperationIds.GET_PRINTER_ATTRIBUTES, [
        keywordAttr('requested-attributes', 'all'),
      ])
    );
    const pa = printerAttrsOf(got);
    expect(firstString(findAttr(pa, 'printer-location'))).toBe('Lab B, Rack 4');
    expect(firstString(findAttr(pa, 'printer-info'))).toBe(
      'Loaner unit — handle with care'
    );
  });

  it('advertises printer-settable-attributes-supported', () => {
    const printer = newPrinter();
    const got = send(
      printer,
      request(OperationIds.GET_PRINTER_ATTRIBUTES, [
        keywordAttr('requested-attributes', 'all'),
      ])
    );
    const settable = allStrings(
      findAttr(printerAttrsOf(got), 'printer-settable-attributes-supported')
    );
    expect(settable).toContain('printer-location');
    expect(settable).toContain('printer-info');
    expect(settable).toContain('printer-name');
  });

  it('an unsettable attribute is reported unsupported but the op still succeeds', () => {
    const printer = newPrinter();
    const set = send(
      printer,
      request(OperationIds.SET_PRINTER_ATTRIBUTES, [], {
        printerAttrs: [
          textWithoutLangAttr('printer-location', 'Floor 2'),
          // printer-make-and-model is NOT settable.
          textWithoutLangAttr('printer-make-and-model', 'hax 9000'),
        ],
      })
    );
    expect(set.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const unsupported = getGroupAttributes(
      set,
      DelimiterTags.UNSUPPORTED_ATTRIBUTES
    );
    expect(findAttr(unsupported, 'printer-make-and-model')).toBeDefined();

    // The settable one still applied; the unsettable one was ignored.
    const got = send(
      printer,
      request(OperationIds.GET_PRINTER_ATTRIBUTES, [
        keywordAttr('requested-attributes', 'all'),
      ])
    );
    const pa = printerAttrsOf(got);
    expect(firstString(findAttr(pa, 'printer-location'))).toBe('Floor 2');
    expect(firstString(findAttr(pa, 'printer-make-and-model'))).toBe(
      'printer-emulator 0.1.0'
    );
  });
});

describe('Set-Job-Attributes (0x0014)', () => {
  /** Submit a held (non-terminal) job and return its job-id. */
  function heldJob(printer: IppPrinter): number {
    const printed = send(
      printer,
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        {
          jobAttrs: [keywordAttr('job-hold-until', 'indefinite')],
          data: PDF,
        }
      )
    );
    expect(firstNumber(findAttr(jobAttrsOf(printed), 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );
    return firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;
  }

  it('renames a held job; Get-Job-Attributes shows the new name', () => {
    const printer = newPrinter();
    const jobId = heldJob(printer);

    const set = send(
      printer,
      request(
        OperationIds.SET_JOB_ATTRIBUTES,
        [integerAttr('job-id', jobId)],
        { jobAttrs: [nameWithoutLangAttr('job-name', 'renamed-job')] }
      )
    );
    expect(set.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    // Still held (rename does not run it).
    expect(firstNumber(findAttr(jobAttrsOf(set), 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );

    const got = send(
      printer,
      request(OperationIds.GET_JOB_ATTRIBUTES, [integerAttr('job-id', jobId)])
    );
    expect(firstString(findAttr(jobAttrsOf(got), 'job-name'))).toBe(
      'renamed-job'
    );
  });

  it('sets job-priority and copies; Get-Job-Attributes echoes them', () => {
    const printer = newPrinter();
    const jobId = heldJob(printer);

    const set = send(
      printer,
      request(OperationIds.SET_JOB_ATTRIBUTES, [integerAttr('job-id', jobId)], {
        jobAttrs: [
          integerAttr('job-priority', 80),
          integerAttr('copies', 3),
        ],
      })
    );
    expect(set.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const got = send(
      printer,
      request(OperationIds.GET_JOB_ATTRIBUTES, [integerAttr('job-id', jobId)])
    );
    const ja = jobAttrsOf(got);
    expect(firstNumber(findAttr(ja, 'job-priority'))).toBe(80);
    expect(firstNumber(findAttr(ja, 'copies'))).toBe(3);
  });

  it('advertises job-settable-attributes-supported', () => {
    const printer = newPrinter();
    const got = send(
      printer,
      request(OperationIds.GET_PRINTER_ATTRIBUTES, [
        keywordAttr('requested-attributes', 'all'),
      ])
    );
    const settable = allStrings(
      findAttr(printerAttrsOf(got), 'job-settable-attributes-supported')
    );
    expect(settable).toContain('job-name');
    expect(settable).toContain('job-priority');
    expect(settable).toContain('copies');
  });

  it('Set-Job-Attributes on a terminal (completed) job -> client-error-not-possible', () => {
    const printer = newPrinter();
    // A plain Print-Job (no hold) runs to completed immediately.
    const printed = send(
      printer,
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        { data: PDF }
      )
    );
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;
    expect(firstNumber(findAttr(jobAttrsOf(printed), 'job-state'))).toBe(
      JobStates.COMPLETED
    );

    const set = send(
      printer,
      request(OperationIds.SET_JOB_ATTRIBUTES, [integerAttr('job-id', jobId)], {
        jobAttrs: [nameWithoutLangAttr('job-name', 'too-late')],
      })
    );
    expect(set.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_POSSIBLE
    );
    expect(jobAttrsOf(set)).toHaveLength(0);
  });

  it('Set-Job-Attributes on an unknown job -> client-error-not-found', () => {
    const printer = newPrinter();
    const set = send(
      printer,
      request(OperationIds.SET_JOB_ATTRIBUTES, [integerAttr('job-id', 9999)], {
        jobAttrs: [nameWithoutLangAttr('job-name', 'nope')],
      })
    );
    expect(set.operationIdOrStatusCode).toBe(StatusCodes.CLIENT_ERROR_NOT_FOUND);
    expect(jobAttrsOf(set)).toHaveLength(0);
  });
});
