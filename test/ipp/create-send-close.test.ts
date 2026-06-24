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

// ── Synthetic PWG-Raster fixtures (mirrors raster-info.test.ts) ─────────────

/** One PWG page-data run: single line, `width` pixels as one repeat run. */
function pwgPageData(width: number): Buffer {
  return Buffer.from([0x00, width - 1, 0xff]);
}

/** A synthetic 1796-byte PWG page header with minimal geometry. */
function pwgPageHeader(widthPx: number): Buffer {
  const h = Buffer.alloc(1796);
  h.writeUInt32BE(300, 276); // HWResolution[0]
  h.writeUInt32BE(300, 280); // HWResolution[1]
  h.writeUInt32BE(widthPx, 372); // cupsWidth
  h.writeUInt32BE(1, 376); // cupsHeight
  h.writeUInt32BE(widthPx, 392); // cupsBytesPerLine (1 byte/pixel)
  return h;
}

/** Build a PWG-Raster blob with `pages` single-line pages. */
function pwgRaster(pages: number): Buffer {
  const parts: Buffer[] = [Buffer.from('RaS2', 'ascii')];
  for (let i = 0; i < pages; i++) {
    parts.push(pwgPageHeader(2), pwgPageData(2));
  }
  return Buffer.concat(parts);
}

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

describe('Create-Job / Send-Document / Close-Job lifecycle', () => {
  it('Create-Job allocates a pending-held job with no documents', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const res = roundTrip(
      request(OperationIds.CREATE_JOB, []),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const attrs = jobAttrsOf(res);
    const jobId = firstNumber(findAttr(attrs, 'job-id'));
    expect(jobId).toBeDefined();
    expect(firstNumber(findAttr(attrs, 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );
    expect(findAttr(attrs, 'job-uri')).toBeDefined();
  });

  it('multi-doc flow: Create-Job -> Send(doc1,last=false) -> Send(doc2,last=true) sums impressions and completes', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    // Create-Job
    const created = roundTrip(request(OperationIds.CREATE_JOB, []), ctx);
    const jobId = firstNumber(findAttr(jobAttrsOf(created), 'job-id'))!;

    // Send-Document #1 — 2-page raster, not last. Job stays held.
    const send1 = roundTrip(
      request(
        OperationIds.SEND_DOCUMENT,
        [
          integerAttr('job-id', jobId),
          mimeMediaTypeAttr('document-format', 'image/pwg-raster'),
          booleanAttr('last-document', false),
          integerAttr('document-number', 1),
        ],
        pwgRaster(2)
      ),
      ctx
    );
    expect(send1.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(send1), 'job-state'))).toBe(
      JobStates.PENDING_HELD
    );

    // Send-Document #2 — 1-page raster, last. Job releases and completes.
    const send2 = roundTrip(
      request(
        OperationIds.SEND_DOCUMENT,
        [
          integerAttr('job-id', jobId),
          mimeMediaTypeAttr('document-format', 'image/pwg-raster'),
          booleanAttr('last-document', true),
          integerAttr('document-number', 2),
        ],
        pwgRaster(1)
      ),
      ctx
    );
    expect(send2.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(send2), 'job-state'))).toBe(
      JobStates.COMPLETED
    );

    // Impressions = sum of both documents' pages (2 + 1).
    const job = queue.get(jobId)!;
    expect(job.impressions).toBe(3);
    expect(job.documents).toHaveLength(2);
    expect(job.stateValue).toBe(JobStates.COMPLETED);

    // Get-Job-Attributes reflects the accumulated impressions.
    const ga = roundTrip(
      request(OperationIds.GET_JOB_ATTRIBUTES, [integerAttr('job-id', jobId)]),
      ctx
    );
    expect(firstNumber(findAttr(jobAttrsOf(ga), 'job-impressions'))).toBe(3);
    expect(
      firstNumber(findAttr(jobAttrsOf(ga), 'job-impressions-completed'))
    ).toBe(3);
  });

  it('Create-Job -> Send(doc, last=false) -> Close-Job releases and completes', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const created = roundTrip(request(OperationIds.CREATE_JOB, []), ctx);
    const jobId = firstNumber(findAttr(jobAttrsOf(created), 'job-id'))!;

    roundTrip(
      request(
        OperationIds.SEND_DOCUMENT,
        [
          integerAttr('job-id', jobId),
          mimeMediaTypeAttr('document-format', 'image/pwg-raster'),
          booleanAttr('last-document', false),
        ],
        pwgRaster(2)
      ),
      ctx
    );

    const closed = roundTrip(
      request(OperationIds.CLOSE_JOB, [integerAttr('job-id', jobId)]),
      ctx
    );
    expect(closed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(closed), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
    expect(queue.get(jobId)!.impressions).toBe(2);
  });

  it('Create-Job -> Close-Job with no documents aborts the empty job', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const created = roundTrip(request(OperationIds.CREATE_JOB, []), ctx);
    const jobId = firstNumber(findAttr(jobAttrsOf(created), 'job-id'))!;

    const closed = roundTrip(
      request(OperationIds.CLOSE_JOB, [integerAttr('job-id', jobId)]),
      ctx
    );
    expect(closed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(closed), 'job-state'))).toBe(
      JobStates.ABORTED
    );
  });

  it('Send-Document to an unknown job returns client-error-not-found', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const res = roundTrip(
      request(
        OperationIds.SEND_DOCUMENT,
        [
          integerAttr('job-id', 9999),
          booleanAttr('last-document', true),
        ],
        Buffer.from('%PDF-1.4')
      ),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_FOUND
    );
    expect(jobAttrsOf(res)).toHaveLength(0);
  });

  it('Send-Document to an already-closed job returns client-error-not-possible', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    // Create + close (last-document) a job, then try to send more.
    const created = roundTrip(request(OperationIds.CREATE_JOB, []), ctx);
    const jobId = firstNumber(findAttr(jobAttrsOf(created), 'job-id'))!;

    roundTrip(
      request(
        OperationIds.SEND_DOCUMENT,
        [
          integerAttr('job-id', jobId),
          mimeMediaTypeAttr('document-format', 'image/pwg-raster'),
          booleanAttr('last-document', true),
        ],
        pwgRaster(1)
      ),
      ctx
    );

    const res = roundTrip(
      request(
        OperationIds.SEND_DOCUMENT,
        [
          integerAttr('job-id', jobId),
          booleanAttr('last-document', true),
        ],
        pwgRaster(1)
      ),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_POSSIBLE
    );
  });

  it('Send-Document to a single-shot Print-Job returns client-error-not-possible', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    // A Print-Job creates a closed job; it cannot receive more documents.
    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'image/pwg-raster')],
        pwgRaster(1)
      ),
      ctx
    );
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;

    const res = roundTrip(
      request(
        OperationIds.SEND_DOCUMENT,
        [integerAttr('job-id', jobId), booleanAttr('last-document', true)],
        pwgRaster(1)
      ),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_NOT_POSSIBLE
    );
  });
});
