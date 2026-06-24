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
  integerAttr,
  keywordAttr,
  mimeMediaTypeAttr,
  rangesAttr,
  findAttr,
  firstNumber,
  firstBoolean,
  allRanges,
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
import { renderRasterJob } from '../../src/documents/raster-render.js';
import { normalizePageRanges } from '../../src/ipp/job-template.js';
import type { Document } from '../../src/documents/document.js';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Helpers (mirror job-template.test.ts) ──────────────────────────────────

function makeContext(queue: JobQueue): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue,
    printerState: () => PrinterStates.IDLE,
  };
}

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

// ── Synthetic multi-page PWG-Raster builder ────────────────────────────────

const lineRepeat = (count: number) => count - 1;
const repeatControl = (count: number) => 257 - count;

/** One 1x1 gray page body: header + one line emitting one pixel `value`. */
function grayPage(value: number): Buffer {
  const h = Buffer.alloc(1796);
  h.writeUInt32BE(300, 276);
  h.writeUInt32BE(300, 280);
  h.writeUInt32BE(1, 372);
  h.writeUInt32BE(1, 376);
  h.writeUInt32BE(8, 384);
  h.writeUInt32BE(8, 388);
  h.writeUInt32BE(1, 392);
  h.writeUInt32BE(18, 400);
  const line = Buffer.from([lineRepeat(1), repeatControl(1), value & 0xff]);
  return Buffer.concat([h, line]);
}

/** A multi-page PWG blob: `RaS2` magic followed by `n` distinct 1x1 pages. */
function multiPagePwg(n: number): Buffer {
  const parts: Buffer[] = [Buffer.from('RaS2', 'ascii')];
  for (let i = 0; i < n; i++) parts.push(grayPage(0x10 + i));
  return Buffer.concat(parts);
}

describe('page-ranges parse + echo (RFC 8011 §5.2.7)', () => {
  it('normalizePageRanges coerces 1-based inclusive ranges, drops junk', () => {
    expect(normalizePageRanges([[2, 3]])).toEqual([{ lower: 2, upper: 3 }]);
    // lower < 1 floors to 1; fractional truncates.
    expect(normalizePageRanges([[0, 2.9]])).toEqual([{ lower: 1, upper: 2 }]);
    // inverted range dropped; absent/empty → undefined (render all).
    expect(normalizePageRanges([[5, 2]])).toBeUndefined();
    expect(normalizePageRanges([])).toBeUndefined();
  });

  it('Print-Job with page-ranges=2-3 stores + echoes it in Get-Job-Attributes', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'image/pwg-raster')],
        [rangesAttr('page-ranges', [2, 3])],
        multiPagePwg(4)
      ),
      ctx
    );
    expect(printed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;

    const ja = jobAttrsOf(
      roundTrip(
        request(OperationIds.GET_JOB_ATTRIBUTES, [
          integerAttr('job-id', jobId),
        ]),
        ctx
      )
    );
    expect(allRanges(findAttr(ja, 'page-ranges'))).toEqual([[2, 3]]);
  });

  it('Print-Job without page-ranges omits it from Get-Job-Attributes', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'image/pwg-raster')],
        [],
        multiPagePwg(2)
      ),
      ctx
    );
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;
    const ja = jobAttrsOf(
      roundTrip(
        request(OperationIds.GET_JOB_ATTRIBUTES, [
          integerAttr('job-id', jobId),
        ]),
        ctx
      )
    );
    expect(findAttr(ja, 'page-ranges')).toBeUndefined();
  });

  it('Get-Printer-Attributes advertises page-ranges-supported=true', () => {
    const printer = new IppPrinter({
      port: 0,
      advertise: false,
      logLevel: 'error',
    });
    const pa = printerAttrsOf(
      decode(
        printer.handleRequest(
          encode(
            request(OperationIds.GET_PRINTER_ATTRIBUTES, [
              keywordAttr('requested-attributes', 'all'),
            ])
          )
        )
      )
    );
    expect(firstBoolean(findAttr(pa, 'page-ranges-supported'))).toBe(true);
  });
});

describe('page-ranges filters which raster pages are rendered', () => {
  it('renders ONLY the selected pages, keeping their actual page numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-page-ranges-'));
    try {
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: multiPagePwg(4),
      };
      const prefix = join(dir, 'out');
      const pages = renderRasterJob([doc], 1, prefix, undefined, false, undefined, [
        { lower: 2, upper: 3 },
      ]);

      // Only pages 2 and 3 written; filenames carry the ACTUAL index (p2/p3).
      expect(pages.map((p) => p.page)).toEqual([2, 3]);
      expect(existsSync(`${prefix}-job1-p1.png`)).toBe(false);
      expect(existsSync(`${prefix}-job1-p2.png`)).toBe(true);
      expect(existsSync(`${prefix}-job1-p3.png`)).toBe(true);
      expect(existsSync(`${prefix}-job1-p4.png`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('absent page-ranges renders every page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-page-ranges-all-'));
    try {
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: multiPagePwg(4),
      };
      const pages = renderRasterJob([doc], 2, join(dir, 'all'), undefined, false);
      expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a range partly out of bounds emits only the pages that exist (no throw)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-page-ranges-oob-'));
    try {
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: multiPagePwg(4),
      };
      const prefix = join(dir, 'oob');
      // 3-10 of a 4-page job → only pages 3 and 4 exist.
      const pages = renderRasterJob([doc], 3, prefix, undefined, false, undefined, [
        { lower: 3, upper: 10 },
      ]);
      expect(pages.map((p) => p.page)).toEqual([3, 4]);
      expect(existsSync(`${prefix}-job3-p3.png`)).toBe(true);
      expect(existsSync(`${prefix}-job3-p4.png`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('IppPrinter threads job.pageRanges into the render path (end to end)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-page-ranges-e2e-'));
    try {
      const printer = new IppPrinter({
        port: 0,
        advertise: false,
        logLevel: 'error',
        rasterOut: join(dir, 'e2e'),
      });
      printer.handleRequest(
        encode(
          request(
            OperationIds.PRINT_JOB,
            [mimeMediaTypeAttr('document-format', 'image/pwg-raster')],
            [rangesAttr('page-ranges', [2, 3])],
            multiPagePwg(4)
          )
        )
      );
      expect(existsSync(join(dir, 'e2e-job1-p1.png'))).toBe(false);
      expect(existsSync(join(dir, 'e2e-job1-p2.png'))).toBe(true);
      expect(existsSync(join(dir, 'e2e-job1-p3.png'))).toBe(true);
      expect(existsSync(join(dir, 'e2e-job1-p4.png'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
