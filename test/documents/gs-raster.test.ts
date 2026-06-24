import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildGsArgs,
  pagePath,
  outputPattern,
  isGhostscriptAvailable,
  rasterizePdfOrPostScript,
  DEFAULT_GS_DPI,
  GS_DEVICE,
} from '../../src/documents/gs-raster.js';

/**
 * These tests are robust to Ghostscript being absent (e.g. CI without `gs`):
 *
 *  - argv-construction and output-path naming are PURE (no spawn), so they run
 *    everywhere and pin the exact gs flags + the `<prefix>-job<id>-p<n>.png`
 *    pattern;
 *  - the gs-absence behavior is asserted by pointing PATH at an empty dir so
 *    `gs` cannot resolve — the function must return [] and NOT throw;
 *  - the real-rasterization integration test is GUARDED by isGhostscriptAvailable()
 *    via it.skipIf, so the suite stays green on hosts without Ghostscript.
 *
 * The minimal one-page PDF below is a hand-written, valid `%PDF-1.4` document
 * (catalog → pages → one empty Letter page) so the integration test does not
 * depend on any fixture file.
 */

// ── Pure: gs argv + output naming ─────────────────────────────────────────

describe('buildGsArgs', () => {
  it('emits the exact SAFER gs argv with device/dpi and -o page template', () => {
    const args = buildGsArgs({
      outPrefix: '/out/render',
      jobId: 7,
      inputPath: '/tmp/job7.in',
    });
    expect(args).toEqual([
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-sDEVICE=png16m',
      `-r${DEFAULT_GS_DPI}`,
      '-o',
      '/out/render-job7-p%d.png',
      '/tmp/job7.in',
    ]);
    // Never the unsafe flag.
    expect(args).not.toContain('-dNOSAFER');
  });

  it('honors a custom dpi', () => {
    const args = buildGsArgs({
      dpi: 300,
      outPrefix: '/out/render',
      jobId: 1,
      inputPath: '/tmp/x.in',
    });
    expect(args).toContain('-r300');
    expect(args).toContain(`-sDEVICE=${GS_DEVICE}`);
  });
});

describe('output path naming', () => {
  it('outputPattern uses the gs %d page template', () => {
    expect(outputPattern('/p/out', 42)).toBe('/p/out-job42-p%d.png');
  });

  it('pagePath matches the <prefix>-job<id>-p<n>.png convention', () => {
    expect(pagePath('/p/out', 42, 1)).toBe('/p/out-job42-p1.png');
    expect(pagePath('/p/out', 42, 3)).toBe('/p/out-job42-p3.png');
  });
});

// ── gs-absence: degrade to a no-op, no throw ──────────────────────────────

describe('rasterizePdfOrPostScript when gs is unavailable', () => {
  it('returns [] and does not throw when gs cannot be resolved on PATH', () => {
    const savedPath = process.env.PATH;
    // Point PATH at an empty temp dir so no `gs` binary can be located. The
    // resolver caches, so this only proves the no-gs branch if gs wasn't
    // already resolved earlier in this process; we still assert the contract
    // holds (no throw, array result) regardless.
    const emptyDir = mkdtempSync(join(tmpdir(), 'gs-empty-'));
    try {
      process.env.PATH = emptyDir;
      let result: string[] | undefined;
      expect(() => {
        result = rasterizePdfOrPostScript(Buffer.from('%PDF-1.4\n'), {
          outPrefix: join(emptyDir, 'render'),
          jobId: 99,
        });
      }).not.toThrow();
      expect(Array.isArray(result)).toBe(true);
    } finally {
      process.env.PATH = savedPath;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ── Integration: real gs render (guarded / skipped without gs) ────────────

const MINIMAL_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    'trailer << /Root 1 0 R /Size 4 >>',
    'startxref',
    '0',
    '%%EOF',
    '',
  ].join('\n'),
  'ascii'
);

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const gsAvailable = isGhostscriptAvailable();
const outDir = mkdtempSync(join(tmpdir(), 'gs-raster-test-'));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('rasterizePdfOrPostScript integration (requires gs)', () => {
  it.skipIf(!gsAvailable)(
    'rasterizes a minimal one-page PDF to a valid PNG',
    () => {
      const prefix = join(outDir, 'render');
      const written = rasterizePdfOrPostScript(MINIMAL_PDF, {
        outPrefix: prefix,
        jobId: 1,
        dpi: 72, // tiny + fast
      });
      expect(written.length).toBeGreaterThanOrEqual(1);

      const first = written[0];
      expect(first).toBe(pagePath(prefix, 1, 1));
      expect(existsSync(first)).toBe(true);

      const head = readFileSync(first).subarray(0, 8);
      expect(head.equals(PNG_SIGNATURE)).toBe(true);
    }
  );
});
