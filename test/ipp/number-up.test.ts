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
  findAttr,
  firstNumber,
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
import {
  renderRasterJob,
  numberUpGrid,
  compositeNUp,
} from '../../src/documents/raster-render.js';
import { normalizeNumberUp } from '../../src/ipp/job-template.js';
import type { Document } from '../../src/documents/document.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Read a PNG IHDR's width/height/color-type. (Signature is 8 bytes; IHDR data
 * starts at byte 16: width@16, height@20, color-type@25.)
 */
function pngHeader(png: Buffer): {
  width: number;
  height: number;
  colorType: number;
} {
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    colorType: png.readUInt8(25),
  };
}

// ── Synthetic PWG builders (mirror raster-rotate.test.ts) ────────────────────

/**
 * Build a single-page PWG-Raster blob whose pixels are taken verbatim from
 * `rows` (one number per pixel for gray, three per pixel for rgb). width =
 * pixels per row; height = rows.length.
 */
function pwgPage(rows: number[][], color: boolean): Buffer {
  const bpp = color ? 3 : 1;
  const width = rows[0].length / bpp;
  const height = rows.length;

  const header = Buffer.alloc(1796);
  header.writeUInt32BE(300, 276); // dpiX
  header.writeUInt32BE(300, 280); // dpiY
  header.writeUInt32BE(width, 372); // cupsWidth
  header.writeUInt32BE(height, 376); // cupsHeight
  header.writeUInt32BE(8, 384); // bitsPerColor
  header.writeUInt32BE(color ? 24 : 8, 388); // bitsPerPixel
  header.writeUInt32BE(width * bpp, 392); // cupsBytesPerLine
  header.writeUInt32BE(color ? 19 : 18, 400); // colorSpace: sRGB / sGray

  const lines: number[] = [];
  for (const row of rows) {
    lines.push(0, width - 1, ...row); // lineRepeat=1, literal control, bytes
  }
  return Buffer.from([...header, ...lines]);
}

/**
 * A multi-page PWG-Raster blob: `RaS2` magic followed by `n` 1x1 gray pages,
 * each a distinct value 0x10, 0x20, 0x30 … so a tiled sheet's cells can be
 * identified by pixel value.
 */
function multiPagePwg(n: number): Buffer {
  const parts: Buffer[] = [Buffer.from('RaS2', 'ascii')];
  for (let i = 0; i < n; i++) {
    parts.push(pwgPage([[0x10 * (i + 1)]], false));
  }
  return Buffer.concat(parts);
}

// ── Pure helpers ──────────────────────────────────────────────────────────

describe('numberUpGrid (cols = ceil(sqrt(n)), rows = ceil(n/cols))', () => {
  it('maps each N to a near-square grid', () => {
    expect(numberUpGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(numberUpGrid(2)).toEqual({ cols: 2, rows: 1 });
    expect(numberUpGrid(4)).toEqual({ cols: 2, rows: 2 });
    expect(numberUpGrid(6)).toEqual({ cols: 3, rows: 2 });
    expect(numberUpGrid(9)).toEqual({ cols: 3, rows: 3 });
    expect(numberUpGrid(16)).toEqual({ cols: 4, rows: 4 });
  });

  it('clamps N < 1 / non-finite to a single 1x1 cell', () => {
    expect(numberUpGrid(0)).toEqual({ cols: 1, rows: 1 });
    expect(numberUpGrid(-3)).toEqual({ cols: 1, rows: 1 });
    expect(numberUpGrid(NaN)).toEqual({ cols: 1, rows: 1 });
  });
});

describe('normalizeNumberUp', () => {
  it('keeps a finite integer ≥ 1, drops < 1 / non-finite / absent', () => {
    expect(normalizeNumberUp(2)).toBe(2);
    expect(normalizeNumberUp(4.9)).toBe(4); // truncated
    expect(normalizeNumberUp(1)).toBe(1);
    expect(normalizeNumberUp(0)).toBeUndefined();
    expect(normalizeNumberUp(-2)).toBeUndefined();
    expect(normalizeNumberUp(undefined)).toBeUndefined();
    expect(normalizeNumberUp(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('compositeNUp tiles pages into a grid', () => {
  it('2-up of two 1x1 gray pages → 2x1 sheet, page A in cell 0, B in cell 1', () => {
    const A = {
      index: 1,
      width: 1,
      height: 1,
      bytesPerPixel: 1,
      isRgb: false,
      pixels: Uint8Array.from([0x10]),
      dpi: 300,
    };
    const B = {
      index: 2,
      width: 1,
      height: 1,
      bytesPerPixel: 1,
      isRgb: false,
      pixels: Uint8Array.from([0x20]),
      dpi: 300,
    };
    const sheet = compositeNUp([A, B], numberUpGrid(2));
    // grid 2x1 → sheet is cellW*cols × cellH*rows = 2 × 1.
    expect(sheet.width).toBe(2);
    expect(sheet.height).toBe(1);
    expect(sheet.isRgb).toBe(false);
    // cell 0 (x=0) = A, cell 1 (x=1) = B.
    expect(Array.from(sheet.pixels)).toEqual([0x10, 0x20]);
  });

  it('promotes gray pages to RGB when the batch mixes color and gray', () => {
    const gray = {
      index: 1,
      width: 1,
      height: 1,
      bytesPerPixel: 1,
      isRgb: false,
      pixels: Uint8Array.from([0x40]),
      dpi: 300,
    };
    const rgb = {
      index: 2,
      width: 1,
      height: 1,
      bytesPerPixel: 3,
      isRgb: true,
      pixels: Uint8Array.from([0xff, 0x00, 0x00]), // red
      dpi: 300,
    };
    const sheet = compositeNUp([gray, rgb], numberUpGrid(2));
    expect(sheet.isRgb).toBe(true);
    expect(sheet.width).toBe(2);
    expect(sheet.height).toBe(1);
    // cell 0 = gray promoted to r=g=b=0x40; cell 1 = red.
    expect(Array.from(sheet.pixels)).toEqual([
      0x40, 0x40, 0x40, 0xff, 0x00, 0x00,
    ]);
  });

  it('a short batch leaves the trailing cell white (0xff)', () => {
    const A = {
      index: 1,
      width: 1,
      height: 1,
      bytesPerPixel: 1,
      isRgb: false,
      pixels: Uint8Array.from([0x10]),
      dpi: 300,
    };
    // 4-up grid (2x2) but only one page → cells 1..3 stay white.
    const sheet = compositeNUp([A], numberUpGrid(4));
    expect(sheet.width).toBe(2);
    expect(sheet.height).toBe(2);
    // 2x2 row-major: [A, white, white, white].
    expect(Array.from(sheet.pixels)).toEqual([0x10, 0xff, 0xff, 0xff]);
  });
});

// ── End to end through renderRasterJob ──────────────────────────────────────

describe('renderRasterJob — number-up tiles pages per sheet', () => {
  it('4-page job at number-up=2 → 2 sheets, each 2 pages tiled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-number-up-'));
    try {
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: multiPagePwg(4), // pages 0x10, 0x20, 0x30, 0x40
      };
      const prefix = join(dir, 'nup');
      const sheets = renderRasterJob(
        [doc],
        1,
        prefix,
        undefined,
        false,
        undefined,
        undefined,
        2
      );

      // Two sheets, numbered by SHEET index starting at 1.
      expect(sheets.map((s) => s.page)).toEqual([1, 2]);
      expect(existsSync(`${prefix}-job1-p1.png`)).toBe(true);
      expect(existsSync(`${prefix}-job1-p2.png`)).toBe(true);
      expect(existsSync(`${prefix}-job1-p3.png`)).toBe(false);

      // Sheet dims = cell(1x1) * grid(2x1) = 2x1.
      const s1 = pngHeader(readFileSync(`${prefix}-job1-p1.png`));
      expect(s1.width).toBe(2);
      expect(s1.height).toBe(1);
      expect(s1.colorType).toBe(0); // grayscale

      // Sheet 2 carries pages 3 & 4 with the same tiled dims. (The exact tiled
      // pixels are asserted directly against compositeNUp below, which avoids
      // re-inflating IDAT here.)
      const s2 = pngHeader(readFileSync(`${prefix}-job1-p2.png`));
      expect(s2.width).toBe(2);
      expect(s2.height).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('number-up=2 composites the right source pixels into each cell', () => {
    // Two 2x1 gray pages so a 2-up (2x1 grid) sheet is 4x1 and we can read the
    // raw row out of the buffer the compositor produced.
    const pageA = {
      index: 1,
      width: 2,
      height: 1,
      bytesPerPixel: 1,
      isRgb: false,
      pixels: Uint8Array.from([0x11, 0x22]),
      dpi: 300,
    };
    const pageB = {
      index: 2,
      width: 2,
      height: 1,
      bytesPerPixel: 1,
      isRgb: false,
      pixels: Uint8Array.from([0x33, 0x44]),
      dpi: 300,
    };
    const sheet = compositeNUp([pageA, pageB], numberUpGrid(2));
    expect(sheet.width).toBe(4);
    expect(sheet.height).toBe(1);
    // cells side by side: A(0x11,0x22) | B(0x33,0x44).
    expect(Array.from(sheet.pixels)).toEqual([0x11, 0x22, 0x33, 0x44]);
  });

  it('number-up=1 keeps one PNG per page (unchanged behavior)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-number-up-1-'));
    try {
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: multiPagePwg(4),
      };
      const prefix = join(dir, 'one');
      const pages = renderRasterJob(
        [doc],
        2,
        prefix,
        undefined,
        false,
        undefined,
        undefined,
        1
      );
      expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
      for (const n of [1, 2, 3, 4]) {
        expect(existsSync(`${prefix}-job2-p${n}.png`)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('color pages at number-up=4 produce one RGB 2x2-grid sheet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-number-up-rgb-'));
    try {
      // Four 1x1 color pages.
      const parts: Buffer[] = [Buffer.from('RaS2', 'ascii')];
      const colors = [
        [0xff, 0x00, 0x00],
        [0x00, 0xff, 0x00],
        [0x00, 0x00, 0xff],
        [0xff, 0xff, 0x00],
      ];
      for (const c of colors) parts.push(pwgPage([c], true));
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: Buffer.concat(parts),
      };
      const prefix = join(dir, 'rgb');
      const sheets = renderRasterJob(
        [doc],
        1,
        prefix,
        undefined,
        false,
        undefined,
        undefined,
        4
      );
      expect(sheets).toHaveLength(1);
      const h = pngHeader(readFileSync(`${prefix}-job1-p1.png`));
      // cell 1x1, grid 2x2 → 2x2 sheet, RGB.
      expect(h.width).toBe(2);
      expect(h.height).toBe(2);
      expect(h.colorType).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── IPP parse / echo / advertise ────────────────────────────────────────────

describe('number-up IPP parse + echo + advertise', () => {
  it('Print-Job with number-up=2 stores + echoes it in Get-Job-Attributes', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'image/pwg-raster')],
        [integerAttr('number-up', 2)],
        multiPagePwg(2)
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
    expect(firstNumber(findAttr(ja, 'number-up'))).toBe(2);
  });

  it('Print-Job without number-up omits it from Get-Job-Attributes', () => {
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
    expect(findAttr(ja, 'number-up')).toBeUndefined();
  });

  it('Get-Printer-Attributes advertises number-up-supported + number-up-default=1', () => {
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
    const supported = (findAttr(pa, 'number-up-supported')?.values ?? []).map(
      (v) => v.value
    );
    expect(supported).toEqual(expect.arrayContaining([1, 2, 4, 6, 9, 16]));
    expect(firstNumber(findAttr(pa, 'number-up-default'))).toBe(1);
  });

  it('IppPrinter threads job.numberUp into the render path (end to end)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-number-up-e2e-'));
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
            [integerAttr('number-up', 2)],
            multiPagePwg(4)
          )
        )
      );
      // 4 pages at 2-up → 2 sheets (p1, p2), not 4 per-page PNGs.
      expect(existsSync(join(dir, 'e2e-job1-p1.png'))).toBe(true);
      expect(existsSync(join(dir, 'e2e-job1-p2.png'))).toBe(true);
      expect(existsSync(join(dir, 'e2e-job1-p3.png'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
