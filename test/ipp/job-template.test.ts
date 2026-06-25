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
  enumAttr,
  keywordAttr,
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
  rgbToLuma,
} from '../../src/documents/raster-render.js';
import type { Document } from '../../src/documents/document.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inflateSync } from 'zlib';

const PDF = Buffer.from('%PDF-1.4');

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

// ── Synthetic raster page builders (mirror raster-decode.test.ts) ──────────

/** Build a synthetic PWG-Raster page header (1796 bytes). */
function pwgPageHeader(opts: {
  width: number;
  height: number;
  bitsPerColor: number;
  bitsPerPixel: number;
  bytesPerLine: number;
  colorSpace: number;
}): Buffer {
  const h = Buffer.alloc(1796);
  h.writeUInt32BE(300, 276); // dpiX
  h.writeUInt32BE(300, 280); // dpiY
  h.writeUInt32BE(opts.width, 372);
  h.writeUInt32BE(opts.height, 376);
  h.writeUInt32BE(opts.bitsPerColor, 384);
  h.writeUInt32BE(opts.bitsPerPixel, 388);
  h.writeUInt32BE(opts.bytesPerLine, 392);
  h.writeUInt32BE(opts.colorSpace, 400);
  return h;
}

const lineRepeat = (count: number) => count - 1;
const repeatControl = (count: number) => 257 - count;

/**
 * A 1x1 sRGB24 color page (pixel = pure red). colorSpace 19 = sRGB.
 * One line, one repeat-run of one RGB group.
 */
function colorPwgPage(): Buffer {
  const header = pwgPageHeader({
    width: 1,
    height: 1,
    bitsPerColor: 8,
    bitsPerPixel: 24,
    bytesPerLine: 3,
    colorSpace: 19,
  });
  const line = [lineRepeat(1), repeatControl(1), 0xff, 0x00, 0x00]; // red
  return Buffer.concat([
    Buffer.from('RaS2', 'ascii'),
    header,
    Buffer.from(line),
  ]);
}

/** The 25th byte of a baseline PNG is the IHDR color-type (0=gray, 2=RGB). */
function pngColorType(png: Buffer): number {
  return png[25];
}

/**
 * Inflate a grayscale PNG's IDAT and return its `width × height` pixel rows
 * (8-bit, 1 byte/pixel), stripping each scanline's leading filter byte.
 */
function pngGrayPixels(png: Buffer, width: number, height: number): number[][] {
  const sig = 8;
  let pos = sig;
  let raw: number[] = [];
  while (pos + 8 <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') {
      raw = Array.from(inflateSync(png.subarray(pos + 8, pos + 8 + length)));
      break;
    }
    pos = pos + 8 + length + 4;
  }
  const rows: number[][] = [];
  const stride = width + 1; // filter byte + width samples
  for (let y = 0; y < height; y++) {
    rows.push(raw.slice(y * stride + 1, y * stride + 1 + width));
  }
  return rows;
}

describe('print Job Template attributes (RFC 8011 §5.2 / PWG 5100.13)', () => {
  it('Print-Job stores + echoes print-color-mode/print-quality/sides/orientation-requested/media', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [
          keywordAttr('print-color-mode', 'monochrome'),
          enumAttr('print-quality', 5),
          keywordAttr('sides', 'two-sided-long-edge'),
          enumAttr('orientation-requested', 4),
          keywordAttr('media', 'na_letter_8.5x11in'),
        ],
        PDF
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
    expect(firstString(findAttr(ja, 'print-color-mode'))).toBe('monochrome');
    expect(firstNumber(findAttr(ja, 'print-quality'))).toBe(5);
    expect(firstString(findAttr(ja, 'sides'))).toBe('two-sided-long-edge');
    expect(firstNumber(findAttr(ja, 'orientation-requested'))).toBe(4);
    expect(firstString(findAttr(ja, 'media'))).toBe('na_letter_8.5x11in');
  });

  it('Get-Jobs echoes the supplied template attributes per job', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [keywordAttr('print-color-mode', 'color'), enumAttr('print-quality', 3)],
        PDF
      ),
      ctx
    );
    const jobs = getGroupAttributes(
      decode(
        encode(
          roundTrip(
            request(OperationIds.GET_JOBS, [
              keywordAttr('which-jobs', 'all'),
            ]),
            ctx
          )
        )
      ),
      DelimiterTags.JOB_ATTRIBUTES
    );
    expect(firstString(findAttr(jobs, 'print-color-mode'))).toBe('color');
    expect(firstNumber(findAttr(jobs, 'print-quality'))).toBe(3);
  });

  it('defaults: a Print-Job with no template attrs omits them from Get-Job-Attributes', () => {
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
    const jobId = firstNumber(findAttr(jobAttrsOf(printed), 'job-id'))!;
    const ja = jobAttrsOf(
      roundTrip(
        request(OperationIds.GET_JOB_ATTRIBUTES, [
          integerAttr('job-id', jobId),
        ]),
        ctx
      )
    );
    // Omitted (not set): the printer's *-default advertises the effective value.
    expect(findAttr(ja, 'print-color-mode')).toBeUndefined();
    expect(findAttr(ja, 'print-quality')).toBeUndefined();
    expect(findAttr(ja, 'sides')).toBeUndefined();
    expect(findAttr(ja, 'orientation-requested')).toBeUndefined();
    expect(findAttr(ja, 'media')).toBeUndefined();
  });

  it('an unknown/invalid template value is ignored (clamped to default → omitted)', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const printed = roundTrip(
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [
          keywordAttr('print-color-mode', 'rainbow'),
          enumAttr('print-quality', 99),
          keywordAttr('sides', 'three-sided'),
        ],
        PDF
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
    expect(findAttr(ja, 'print-color-mode')).toBeUndefined();
    expect(findAttr(ja, 'print-quality')).toBeUndefined();
    expect(findAttr(ja, 'sides')).toBeUndefined();
  });

  it('Set-Job-Attributes changes template attributes on a non-terminal job', () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    // Held job is non-terminal (pending-held) so it is a legal Set target.
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

    const set = roundTrip(
      request(
        OperationIds.SET_JOB_ATTRIBUTES,
        [integerAttr('job-id', jobId)],
        [
          keywordAttr('print-color-mode', 'monochrome'),
          keywordAttr('sides', 'two-sided-short-edge'),
        ]
      ),
      ctx
    );
    expect(set.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstString(findAttr(jobAttrsOf(set), 'print-color-mode'))).toBe(
      'monochrome'
    );
    expect(firstString(findAttr(jobAttrsOf(set), 'sides'))).toBe(
      'two-sided-short-edge'
    );
  });

  it('Get-Printer-Attributes advertises the new *-supported / *-default', () => {
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

    const colorModes = allStrings(findAttr(pa, 'print-color-mode-supported'));
    expect(colorModes).toEqual(
      expect.arrayContaining(['auto', 'color', 'monochrome'])
    );
    expect(firstString(findAttr(pa, 'print-color-mode-default'))).toBe('auto');

    const qualities = (findAttr(pa, 'print-quality-supported')?.values ?? []).map(
      (v) => v.value
    );
    expect(qualities).toEqual(expect.arrayContaining([3, 4, 5]));
    expect(firstNumber(findAttr(pa, 'print-quality-default'))).toBe(4);

    const sides = allStrings(findAttr(pa, 'sides-supported'));
    expect(sides).toEqual(
      expect.arrayContaining([
        'one-sided',
        'two-sided-long-edge',
        'two-sided-short-edge',
      ])
    );
    expect(firstString(findAttr(pa, 'sides-default'))).toBe('one-sided');

    const orientations = (
      findAttr(pa, 'orientation-requested-supported')?.values ?? []
    ).map((v) => v.value);
    expect(orientations).toEqual(expect.arrayContaining([3, 4, 5, 6]));
    expect(firstNumber(findAttr(pa, 'orientation-requested-default'))).toBe(3);

    const media = allStrings(findAttr(pa, 'media-supported'));
    expect(media).toEqual(
      expect.arrayContaining(['iso_a4_210x297mm', 'na_letter_8.5x11in'])
    );
    expect(firstString(findAttr(pa, 'media-default'))).toBe('iso_a4_210x297mm');

    // job-settable-attributes-supported now includes the new template attrs.
    const settable = allStrings(findAttr(pa, 'job-settable-attributes-supported'));
    expect(settable).toEqual(
      expect.arrayContaining([
        'print-color-mode',
        'print-quality',
        'sides',
        'orientation-requested',
        'media',
      ])
    );
  });
});

describe('print-color-mode=monochrome forces grayscale raster output', () => {
  it('rgbToLuma converts an RGB pixel to Rec.601 luma', () => {
    // Pure red 0xff0000 → round(0.299*255) = 76.
    expect(rgbToLuma(Uint8Array.from([0xff, 0x00, 0x00]), 1)[0]).toBe(76);
  });

  it('a color page renders grayscale under forceGrayscale, color otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-job-template-'));
    try {
      const doc: Document = { format: 'image/pwg-raster', bytes: colorPwgPage() };

      // color/auto: the color page goes through the truecolor encoder.
      const colorPrefix = join(dir, 'color');
      const colorPages = renderRasterJob([doc], 1, colorPrefix, undefined, false);
      expect(colorPages).toHaveLength(1);
      expect(pngColorType(readFileSync(colorPages[0].path))).toBe(2); // RGB

      // monochrome: the same color page is forced to grayscale.
      const grayPrefix = join(dir, 'gray');
      const grayPages = renderRasterJob([doc], 2, grayPrefix, undefined, true);
      expect(grayPages).toHaveLength(1);
      expect(pngColorType(readFileSync(grayPages[0].path))).toBe(0); // grayscale
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('IppPrinter wires print-color-mode=monochrome into the render path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-job-template-e2e-'));
    try {
      const printer = new IppPrinter({
        port: 0,
        advertise: false,
        logLevel: 'error',
        rasterOut: join(dir, 'out'),
      });

      printer.handleRequest(
        encode(
          request(
            OperationIds.PRINT_JOB,
            [mimeMediaTypeAttr('document-format', 'image/pwg-raster')],
            [keywordAttr('print-color-mode', 'monochrome')],
            colorPwgPage()
          )
        )
      );

      const png = readFileSync(join(dir, 'out-job1-p1.png'));
      expect(pngColorType(png)).toBe(0); // grayscale, despite a color source
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('IppPrinter wires print-quality=draft into the render path (half resolution)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-job-template-quality-e2e-'));
    try {
      // A 4x2 gray page so a 0.5× draft downscale is observable (→ 2x1).
      const header = pwgPageHeader({
        width: 4,
        height: 2,
        bitsPerColor: 8,
        bitsPerPixel: 8,
        bytesPerLine: 4,
        colorSpace: 18, // sGray
      });
      const line = (...px: number[]) => [lineRepeat(1), repeatControl(1), ...px];
      const gray4x2 = Buffer.concat([
        Buffer.from('RaS2', 'ascii'),
        header,
        Buffer.from([...line(10, 20, 30, 40), ...line(50, 60, 70, 80)]),
      ]);

      // draft (3) → 0.5× downscale: the 4x2 page lands as a 2x1 PNG.
      const draftPrinter = new IppPrinter({
        port: 0,
        advertise: false,
        logLevel: 'error',
        rasterOut: join(dir, 'draft'),
      });
      draftPrinter.handleRequest(
        encode(
          request(
            OperationIds.PRINT_JOB,
            [mimeMediaTypeAttr('document-format', 'image/pwg-raster')],
            [enumAttr('print-quality', 3)],
            gray4x2
          )
        )
      );
      const draftPng = readFileSync(join(dir, 'draft-job1-p1.png'));
      expect(draftPng.readUInt32BE(16)).toBe(2); // width halved
      expect(draftPng.readUInt32BE(20)).toBe(1); // height halved

      // high (5) → full resolution: the 4x2 page stays 4x2.
      const highPrinter = new IppPrinter({
        port: 0,
        advertise: false,
        logLevel: 'error',
        rasterOut: join(dir, 'high'),
      });
      highPrinter.handleRequest(
        encode(
          request(
            OperationIds.PRINT_JOB,
            [mimeMediaTypeAttr('document-format', 'image/pwg-raster')],
            [enumAttr('print-quality', 5)],
            gray4x2
          )
        )
      );
      const highPng = readFileSync(join(dir, 'high-job1-p1.png'));
      expect(highPng.readUInt32BE(16)).toBe(4); // full width
      expect(highPng.readUInt32BE(20)).toBe(2); // full height
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('IppPrinter wires sides=two-sided-short-edge into the render path (tumble)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-job-template-sides-e2e-'));
    try {
      // A two-page 2x2 gray raster with distinct per-page corner values so a
      // 180° back-page tumble is observable.
      const page = (...px: number[]) => {
        const header = pwgPageHeader({
          width: 2,
          height: 2,
          bitsPerColor: 8,
          bitsPerPixel: 8,
          bytesPerLine: 2,
          colorSpace: 18, // sGray
        });
        // lineRepeat=1 (byte 0), literal control = (#groups - 1) = width-1, then
        // the row's pixel bytes (one literal run of `width` groups).
        const line = (a: number, b: number) => [lineRepeat(1), 1, a, b];
        return Buffer.concat([
          header,
          Buffer.from([...line(px[0], px[1]), ...line(px[2], px[3])]),
        ]);
      };
      const twoPage = Buffer.concat([
        Buffer.from('RaS2', 'ascii'),
        page(11, 12, 13, 14), // page 1 (front)
        page(21, 22, 23, 24), // page 2 (back)
      ]);

      const printer = new IppPrinter({
        port: 0,
        advertise: false,
        logLevel: 'error',
        rasterOut: join(dir, 'out'),
      });
      printer.handleRequest(
        encode(
          request(
            OperationIds.PRINT_JOB,
            [mimeMediaTypeAttr('document-format', 'image/pwg-raster')],
            [keywordAttr('sides', 'two-sided-short-edge')],
            twoPage
          )
        )
      );

      // Page 1 (odd/front): unchanged.
      const p1 = pngGrayPixels(readFileSync(join(dir, 'out-job1-p1.png')), 2, 2);
      expect(p1).toEqual([
        [11, 12],
        [13, 14],
      ]);
      // Page 2 (even/back): rotated 180° — top-left value lands bottom-right.
      const p2 = pngGrayPixels(readFileSync(join(dir, 'out-job1-p2.png')), 2, 2);
      expect(p2).toEqual([
        [24, 23],
        [22, 21],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
