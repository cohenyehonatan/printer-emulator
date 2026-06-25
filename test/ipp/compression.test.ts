import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
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
  keywordAttr,
  booleanAttr,
  integerAttr,
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
import { dispatch, type OperationContext } from '../../src/ipp/dispatcher.js';
import { JobQueue } from '../../src/printer/job-queue.js';
import {
  DEFAULT_IDENTITY,
  buildPrinterAttributes,
} from '../../src/printer/printer-attributes.js';
import { Mime } from '../../src/documents/formats.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii');
const TEXT_BYTES = Buffer.from('Hello, compressed world!\n'.repeat(8), 'ascii');

// ── Request builders ────────────────────────────────────────────────────────

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

describe('IPP document compression (RFC 8011 §5.2.3)', () => {
  it('decompresses a gzipped PDF (compression=gzip) and completes the job', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const gz = zlib.gzipSync(PDF_BYTES);

    const res = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [keywordAttr('compression', 'gzip')],
        gz
      ),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const attrs = jobAttrsOf(res);
    const jobId = firstNumber(findAttr(attrs, 'job-id'))!;
    const job = queue.get(jobId)!;

    // The DECOMPRESSED bytes (not the gzip envelope) reached the job, and the
    // format was sniffed from the original document, not the gzip magic.
    expect(job.documents[0].bytes.equals(PDF_BYTES)).toBe(true);
    expect(job.documents[0].format).toBe(Mime.PDF);
    expect(job.stateValue).toBe(JobStates.COMPLETED);
  });

  it('decompresses a deflate (zlib-wrapped) text document', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const wrapped = zlib.deflateSync(TEXT_BYTES); // RFC 1950 zlib header

    const res = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [keywordAttr('compression', 'deflate')],
        wrapped
      ),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const jobId = firstNumber(findAttr(jobAttrsOf(res), 'job-id'))!;
    const job = queue.get(jobId)!;
    expect(job.documents[0].bytes.equals(TEXT_BYTES)).toBe(true);
    expect(job.stateValue).toBe(JobStates.COMPLETED);
  });

  it('decompresses a RAW deflate (RFC 1951, no zlib header) text document', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const raw = zlib.deflateRawSync(TEXT_BYTES); // RFC 1951, no header

    const res = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [keywordAttr('compression', 'deflate')],
        raw
      ),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const jobId = firstNumber(findAttr(jobAttrsOf(res), 'job-id'))!;
    const job = queue.get(jobId)!;
    expect(job.documents[0].bytes.equals(TEXT_BYTES)).toBe(true);
  });

  it('compression=none / absent leaves bytes byte-identical', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const resNone = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [keywordAttr('compression', 'none')],
        PDF_BYTES
      ),
      ctx
    );
    const jobNone = queue.get(
      firstNumber(findAttr(jobAttrsOf(resNone), 'job-id'))!
    )!;
    expect(jobNone.documents[0].bytes.equals(PDF_BYTES)).toBe(true);

    const resAbsent = roundTrip(
      request(OperationIds.PRINT_JOB, [], PDF_BYTES),
      ctx
    );
    const jobAbsent = queue.get(
      firstNumber(findAttr(jobAttrsOf(resAbsent), 'job-id'))!
    )!;
    expect(jobAbsent.documents[0].bytes.equals(PDF_BYTES)).toBe(true);
  });

  it('rejects an unknown compression value with 0x040E', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const res = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [keywordAttr('compression', 'bzip2')],
        PDF_BYTES
      ),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_COMPRESSION_NOT_SUPPORTED
    );
    expect(res.operationIdOrStatusCode).toBe(0x040e);
    // No job was created.
    expect(queue.get(1)).toBeUndefined();
  });

  it('rejects a corrupt gzip body with client-error-document-format-error (0x040A)', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const corrupt = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);

    const res = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [keywordAttr('compression', 'gzip')],
        corrupt
      ),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_DOCUMENT_FORMAT_ERROR
    );
    expect(res.operationIdOrStatusCode).toBe(0x040a);
  });

  it('Send-Document applies per-document gzip decompression', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    // Create-Job → open multi-document job.
    const created = roundTrip(request(OperationIds.CREATE_JOB, []), ctx);
    const jobId = firstNumber(findAttr(jobAttrsOf(created), 'job-id'))!;

    const gz = zlib.gzipSync(TEXT_BYTES);
    const res = roundTrip(
      request(
        OperationIds.SEND_DOCUMENT,
        [
          integerAttr('job-id', jobId),
          keywordAttr('compression', 'gzip'),
          booleanAttr('last-document', true),
        ],
        gz
      ),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const job = queue.get(jobId)!;
    expect(job.documents[0].bytes.equals(TEXT_BYTES)).toBe(true);
    expect(job.stateValue).toBe(JobStates.COMPLETED);
  });

  it('advertises compression-supported = none, gzip, deflate', () => {
    // Round-trip the printer-description group over the wire so the assertion
    // reflects what a real Get-Printer-Attributes client would decode.
    const attrs = buildPrinterAttributes(DEFAULT_IDENTITY);
    const printerAttrs = getGroupAttributes(
      decode(
        encode({
          versionMajor: IPP_VERSION_MAJOR,
          versionMinor: IPP_VERSION_MINOR,
          operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
          requestId: 1,
          groups: [
            {
              tag: DelimiterTags.PRINTER_ATTRIBUTES,
              attributes: attrs,
            },
          ],
        })
      ),
      DelimiterTags.PRINTER_ATTRIBUTES
    );
    const supported = allStrings(
      findAttr(printerAttrs, 'compression-supported')
    );
    expect(supported).toEqual(['none', 'gzip', 'deflate']);
  });
});
