/**
 * Ghostscript-backed PDF / PostScript → PNG rasterizer (opt-in side effect).
 *
 * Where `raster-render.ts` decodes PWG/URF raster jobs to PNGs in-process, this
 * module handles the page-description formats those raster paths can't: PDF and
 * PostScript. It mirrors the CUPS filter chain — CUPS shells out to Ghostscript
 * (`gstoraster`/`pdftoraster`) to interpret PDF/PS — by spawning the system
 * `gs` binary to render one PNG per page.
 *
 * The job bytes are written to a temp file and `gs` is invoked with the SAFER
 * flags to render to `<prefix>-job<jobId>-p%d.png` (gs substitutes the 1-based
 * page number for `%d`), matching the `<prefix>-job<id>-p<n>.png` naming the
 * PWG/URF path uses. The produced PNG paths are returned by stat-ing the
 * `-p<n>.png` files (gs decides the page count).
 *
 * Opt-in + degrade-gracefully: callers invoke this only when a render target is
 * configured, and it NEVER throws — a missing `gs` binary or a gs error is
 * logged and yields an empty list, so default runs, CI without Ghostscript, and
 * malformed jobs all stay green.
 *
 * Security: the temp file path is passed as a spawn argv element (array form, no
 * shell), so there is no shell-injection surface, and `-dSAFER` is always on
 * (never `-dNOSAFER`) to sandbox the interpreter against the untrusted job bytes.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import type { Logger } from '../logging/logger.js';

/** Default render resolution (dots per inch). Matches CUPS' common 150dpi. */
export const DEFAULT_GS_DPI = 150;

/**
 * Output device: png16m = 24-bit truecolor PNG (full color, the lossless
 * superset). We render in color rather than `pnggray` so a colored PDF/PS job
 * lands faithfully; the existing PWG/URF path is grayscale because that's what
 * its decoder produces, but a real PDF can be color.
 */
export const GS_DEVICE = 'png16m';

export interface GsRasterOptions {
  /** Render resolution in DPI. Defaults to DEFAULT_GS_DPI (150). */
  dpi?: number;
  /** Filesystem path prefix shared with the PWG/URF raster output. */
  outPrefix: string;
  /** Job id, woven into the `-job<id>-` segment of each PNG name. */
  jobId: number;
  /** Optional logger for warnings / written-path info. */
  logger?: Logger;
}

/**
 * Build the `gs` argv (excluding the binary name) for rendering `inputPath` to
 * `<outPrefix>-job<jobId>-p%d.png`. Pure + side-effect-free so it can be unit
 * tested without spawning. The page-number template `%d` is gs syntax — gs
 * expands it to the 1-based page index, producing `-p1.png`, `-p2.png`, ….
 */
export function buildGsArgs(opts: {
  dpi?: number;
  outPrefix: string;
  jobId: number;
  inputPath: string;
}): string[] {
  const dpi = opts.dpi ?? DEFAULT_GS_DPI;
  return [
    '-dSAFER',
    '-dBATCH',
    '-dNOPAUSE',
    `-sDEVICE=${GS_DEVICE}`,
    `-r${dpi}`,
    '-o',
    outputPattern(opts.outPrefix, opts.jobId),
    opts.inputPath,
  ];
}

/** The gs `-o` output template for a job: `<prefix>-job<id>-p%d.png`. */
export function outputPattern(outPrefix: string, jobId: number): string {
  return `${outPrefix}-job${jobId}-p%d.png`;
}

/** The concrete PNG path for one rendered page: `<prefix>-job<id>-p<n>.png`. */
export function pagePath(outPrefix: string, jobId: number, page: number): string {
  return `${outPrefix}-job${jobId}-p${page}.png`;
}

/**
 * Rasterize a PDF or PostScript document to one PNG per page using Ghostscript.
 *
 * Writes `bytes` to a unique temp file, spawns `gs` (resolved from PATH) with
 * the SAFER flags to emit `<outPrefix>-job<jobId>-p<n>.png`, then collects the
 * page PNGs that were actually produced (gs decides the page count). The temp
 * file is always cleaned up.
 *
 * Returns the list of written PNG paths in page order. NEVER throws: if `gs` is
 * unavailable the feature degrades to a logged no-op returning `[]`; a gs error
 * or a write failure is logged and also yields whatever (possibly empty) set of
 * pages landed on disk.
 */
export function rasterizePdfOrPostScript(
  bytes: Buffer | Uint8Array,
  opts: GsRasterOptions
): string[] {
  const { outPrefix, jobId, logger } = opts;

  const gs = resolveGs();
  if (!gs) {
    logger?.warn('Ghostscript (gs) not found on PATH; skipping PDF/PS raster', {
      jobId,
    });
    return [];
  }

  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'printer-emu-gs-'));
    const inputPath = join(tempDir, `job${jobId}.in`);
    writeFileSync(inputPath, bytes);

    const args = buildGsArgs({
      dpi: opts.dpi,
      outPrefix,
      jobId,
      inputPath,
    });

    const result = spawnSync(gs, args, {
      encoding: 'utf8',
      // No shell: argv is passed as an array, so the temp path cannot inject.
      shell: false,
    });

    if (result.error) {
      logger?.warn('Ghostscript failed to spawn; skipping PDF/PS raster', {
        jobId,
        error: result.error.message,
      });
      return [];
    }
    if (result.status !== 0) {
      logger?.warn('Ghostscript exited non-zero while rasterizing', {
        jobId,
        status: result.status,
        stderr: trimStderr(result.stderr),
      });
      // Fall through — gs may still have emitted some pages before failing.
    }

    // gs decides the page count; discover the produced files by probing
    // -p1.png, -p2.png, … until the first gap.
    const written: string[] = [];
    for (let page = 1; ; page++) {
      const path = pagePath(outPrefix, jobId, page);
      if (!existsSync(path)) break;
      written.push(path);
      logger?.info('Rendered PDF/PS page to PNG', { path, page, dpi: opts.dpi ?? DEFAULT_GS_DPI });
    }

    if (written.length === 0) {
      logger?.warn('Ghostscript produced no PNG pages', {
        jobId,
        stderr: trimStderr(result.stderr),
      });
    }
    return written;
  } catch (err) {
    logger?.warn('PDF/PS rasterization failed', {
      jobId,
      error: (err as Error).message,
    });
    return [];
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; ignore.
      }
    }
  }
}

/** Whether a usable Ghostscript binary is resolvable on this host. */
export function isGhostscriptAvailable(): boolean {
  return resolveGs() !== undefined;
}

// ── gs binary resolution (cached) ─────────────────────────────────────────

let gsPathCache: string | null | undefined;

/**
 * Resolve the `gs` binary once, from PATH. Returns the absolute path (or bare
 * `gs` name where it's only locatable by the OS), or undefined when absent.
 * Cached so repeated jobs don't re-probe the filesystem.
 */
function resolveGs(): string | undefined {
  if (gsPathCache !== undefined) return gsPathCache ?? undefined;
  gsPathCache = locateGs();
  return gsPathCache ?? undefined;
}

function locateGs(): string | null {
  const pathEnv = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `gs${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Collapse gs stderr to a short single-line summary for structured logs. */
function trimStderr(stderr: string | undefined): string {
  if (!stderr) return '';
  const flat = stderr.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}
