/**
 * IPP Printer object orchestrator.
 *
 * The device-level emulator analog of pectab's Atbpr: owns the printer
 * identity, job queue, and live printer-state; builds the OperationContext;
 * and wires the HTTP/IPP transport to the dispatcher. Extends EventEmitter so
 * callers can observe lifecycle and per-request activity. start()/stop()
 * manage the underlying HTTP server.
 */

import { EventEmitter } from 'events';
import { Logger } from '../logging/logger.js';
import { JobQueue } from './job-queue.js';
import { JobState } from './states.js';
import {
  DEFAULT_IDENTITY,
  type PrinterIdentity,
} from './printer-attributes.js';
import { dispatch, type OperationContext } from '../ipp/dispatcher.js';
import { decode } from '../ipp/decoder.js';
import { encode } from '../ipp/encoder.js';
import { IppHttpServer } from '../transport/http-server.js';
import { IppHttpsServer } from '../transport/https-server.js';
import { ensureSelfSignedCert } from '../transport/tls-cert.js';
import { MdnsAdvertiser } from '../transport/mdns.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PrinterStates,
  StatusCodes,
  DEFAULT_TLS_PORT,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
  type PrinterStateValue,
} from '../ipp/constants.js';
import type { IppResponse } from '../ipp/message.js';
import type { Job } from './job.js';
import { renderRasterJob } from '../documents/raster-render.js';
import { rasterizePdfOrPostScript } from '../documents/gs-raster.js';
import { Mime } from '../documents/formats.js';

export interface IppPrinterConfig {
  port: number;
  identity?: Partial<PrinterIdentity>;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Opt-in raster output: a filesystem path prefix. When set, completed jobs
   * are rendered and one PNG is written per page as `<prefix>-job<id>-p<n>.png`.
   * PWG/URF jobs are decoded in-process; PDF/PostScript jobs are rasterized via
   * the system Ghostscript (`gs`) binary, the same approach CUPS uses. Off by
   * default (no rendering side effects). Formats with no rasterizer (and hosts
   * without `gs`) write nothing.
   */
  rasterOut?: string;
  /**
   * Advertise the printer over mDNS/DNS-SD (AirPrint discovery). Defaults to
   * true; tests/CI and in-process demos set it false to avoid leaving a
   * multicast socket open that would block clean process exit.
   */
  advertise?: boolean;
  /** Hostname used in the mDNS adminurl TXT key. Defaults to 'localhost'. */
  host?: string;
  /**
   * Opt-in IPPS (IPP over TLS). When true, the printer also serves
   * `ipps://…/ipp/print` over HTTPS on `tlsPort` (sharing the same request
   * handler) using an auto-generated self-signed cert, and advertises
   * `_ipps._tcp` for AirPrint. Defaults to FALSE so existing demos/tests/CI are
   * unchanged. If cert generation fails (no openssl), the printer logs a warning
   * and runs plaintext-only.
   */
  tls?: boolean;
  /** TLS/IPPS listen port. Defaults to DEFAULT_TLS_PORT (6311). */
  tlsPort?: number;
  /**
   * Directory for the self-signed cert/key PEM files. Defaults to `.certs/`
   * under the current working directory (git-ignored). Reused across starts.
   */
  certDir?: string;
}

export class IppPrinter extends EventEmitter {
  readonly identity: PrinterIdentity;
  private readonly queue = new JobQueue();
  private readonly logger: Logger;
  private readonly server: IppHttpServer;
  private httpsServer: IppHttpsServer | null = null;
  /** ipps:// URI advertised once the TLS server is up; null while plaintext-only. */
  private ippsUri: string | null = null;
  private mdns: MdnsAdvertiser | null = null;
  private state: PrinterStateValue = PrinterStates.IDLE;
  /**
   * Whether the printer is paused (Pause-Printer, 0x0010). While paused,
   * liveState() reports `stopped` and the job-running operation paths defer
   * jobs (leaving them `pending`) instead of printing them. Resume-Printer
   * clears the flag and runs the deferred jobs.
   */
  private paused = false;

  constructor(private readonly config: IppPrinterConfig) {
    super();
    this.identity = {
      ...DEFAULT_IDENTITY,
      uri: `ipp://localhost:${config.port}/ipp/print`,
      ...config.identity,
    };
    this.logger = new Logger('PRINTER', config.logLevel ?? 'info');
    this.server = new IppHttpServer(config.port, (body) =>
      this.handleRequest(body)
    );
  }

  /** Start the HTTP/IPP server. */
  async start(): Promise<void> {
    this.logger.section('IPP Printer Starting');
    await this.server.listen();
    this.state = PrinterStates.IDLE;
    this.logger.info('IPP printer listening', {
      uri: this.identity.uri,
      port: this.config.port,
    });

    // Opt-in IPPS (IPP over TLS). Generate (or reuse) a self-signed cert and,
    // if successful, start the HTTPS server reusing the same request handler.
    // Cert failure (e.g. no openssl) is non-fatal: log + continue plaintext.
    if (this.config.tls) {
      await this.startTls();
    }

    // Advertise over mDNS once the server(s) are accepting connections. When
    // TLS is up, also publish the secure `_ipps._tcp` service.
    if (this.config.advertise ?? true) {
      const tlsPort = this.config.tlsPort ?? DEFAULT_TLS_PORT;
      this.mdns = new MdnsAdvertiser({
        identity: this.identity,
        port: this.config.port,
        host: this.config.host,
        ipps: this.ippsUri
          ? {
              identity: this.identity,
              port: tlsPort,
              host: this.config.host,
            }
          : undefined,
      });
      this.mdns.start();
    }

    this.emit('started');
  }

  /**
   * Bring up the IPPS (TLS) server: ensure a self-signed cert, then start an
   * HTTPS server on tlsPort reusing this.handleRequest. On cert failure (no
   * openssl, openssl error) this logs a warning and returns without starting
   * TLS — the plaintext HTTP server is unaffected. Never throws.
   */
  private async startTls(): Promise<void> {
    const certDir = this.config.certDir ?? join(process.cwd(), '.certs');
    const tlsPort = this.config.tlsPort ?? DEFAULT_TLS_PORT;
    const cert = ensureSelfSignedCert(certDir, this.logger);
    if (!cert) {
      this.logger.warn('TLS requested but no certificate available; serving plaintext IPP only');
      return;
    }
    try {
      const tlsOptions = {
        cert: readFileSync(cert.certPath),
        key: readFileSync(cert.keyPath),
      };
      this.httpsServer = new IppHttpsServer(tlsPort, tlsOptions, (body) =>
        this.handleRequest(body)
      );
      await this.httpsServer.listen();
      this.ippsUri = `ipps://${this.config.host ?? 'localhost'}:${tlsPort}/ipp/print`;
      this.logger.info('IPPS (IPP over TLS) listening', {
        uri: this.ippsUri,
        port: tlsPort,
      });
    } catch (err) {
      this.logger.warn('Failed to start IPPS server; serving plaintext IPP only', {
        error: (err as Error).message,
      });
      this.httpsServer = null;
      this.ippsUri = null;
    }
  }

  /** Stop mDNS advertising (if any) and the HTTP/IPP + IPPS servers. */
  async stop(): Promise<void> {
    if (this.mdns) {
      await this.mdns.stop();
      this.mdns = null;
    }
    if (this.httpsServer) {
      await this.httpsServer.close();
      this.httpsServer = null;
    }
    this.ippsUri = null;
    await this.server.close();
    this.logger.info('IPP printer stopped');
    this.emit('stopped');
  }

  /** Current job queue (for inspection/tests). */
  getQueue(): JobQueue {
    return this.queue;
  }

  /** Current printer-state value. */
  getState(): PrinterStateValue {
    return this.state;
  }

  private buildContext(): OperationContext {
    return {
      identity: this.identity,
      queue: this.queue,
      ippsUri: this.ippsUri ?? undefined,
      printerState: () => this.liveState(),
      printerStateReasons: () => this.liveReasons(),
      isPaused: () => this.paused,
      pausePrinter: () => this.pause(),
      resumePrinter: () => this.resume(),
      renderRaster: this.config.rasterOut
        ? (job: Job) => this.renderRaster(job)
        : undefined,
      setPrinterAttributes: (overrides) => this.setPrinterAttributes(overrides),
    };
  }

  /**
   * Apply settable printer-description attributes (Set-Printer-Attributes, RFC
   * 3380 §4.1) as overrides on the live printer identity. Because `identity` is
   * a mutable plain object shared with the OperationContext, mutating its
   * settable fields in place makes a subsequent Get-Printer-Attributes report
   * the new values. Only the writable fields (name, info, location,
   * geoLocation, organization) are touched; everything else (uri, uuid,
   * makeAndModel) is left as-is. NOTE: real IPP gates these writes behind
   * operator/admin policy — this emulator has no auth layer (see README).
   */
  setPrinterAttributes(overrides: Partial<PrinterIdentity>): void {
    if (overrides.name !== undefined) this.identity.name = overrides.name;
    if (overrides.info !== undefined) this.identity.info = overrides.info;
    if (overrides.location !== undefined) {
      this.identity.location = overrides.location;
    }
    if (overrides.geoLocation !== undefined) {
      this.identity.geoLocation = overrides.geoLocation;
    }
    if (overrides.organization !== undefined) {
      this.identity.organization = overrides.organization;
    }
  }

  /**
   * Pause the printer (Pause-Printer, 0x0010). Sets the paused flag so
   * liveState() reports `stopped` and subsequent job submissions are deferred.
   * Idempotent.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.logger.stateChange('idle/processing', 'stopped', 'Pause-Printer');
  }

  /**
   * Resume the printer (Resume-Printer, 0x0011). Clears the paused flag and
   * runs any jobs that were deferred while paused. Idempotent.
   */
  resume(): void {
    if (!this.paused) {
      // Not paused — still run any pending jobs defensively, but there should
      // be none deferred.
      this.runPendingJobs();
      return;
    }
    this.paused = false;
    this.logger.stateChange('stopped', 'idle', 'Resume-Printer');
    this.runPendingJobs();
  }

  /**
   * Run every deferred job — those left `pending` (released, not held) while
   * the printer was paused — through the existing run-to-completion path
   * (pending → processing → completed), rendering raster pages when an output
   * target is configured. Held (`pending-held`) jobs are left untouched.
   */
  runPendingJobs(): void {
    for (const job of this.queue.list()) {
      if (job.state === JobState.PENDING) {
        job.process();
        this.renderRaster(job);
      }
    }
  }

  /**
   * Render a finished job's pages to PNGs under the configured `rasterOut`
   * prefix. PWG/URF documents are decoded in-process; PDF/PostScript documents
   * are rasterized via Ghostscript (`gs`). Other formats (and hosts without
   * `gs`) produce nothing. Never throws. When PDF/PS rendering reveals the page
   * count, the job's reported impressions are reconciled best-effort.
   *
   * The job's `print-color-mode=monochrome` forces the in-process PWG/URF path
   * to emit grayscale PNGs even for color pages, and `orientation-requested`
   * rotates the decoded PWG/URF page (90°/180°/270°) before encoding. (The
   * Ghostscript PDF/PS path is left in color and unrotated regardless — gs
   * colour/orientation control isn't threaded here; see README.)
   */
  private renderRaster(job: Job): void {
    const prefix = this.config.rasterOut;
    if (!prefix) return;

    // In-process PWG/URF raster decode. monochrome → force grayscale output;
    // orientation-requested → rotate the decoded page before encoding.
    const forceGrayscale = job.printColorMode === 'monochrome';
    renderRasterJob(
      job.documents,
      job.id,
      prefix,
      this.logger,
      forceGrayscale,
      job.orientation
    );

    // Ghostscript-backed PDF/PostScript rasterization. gs numbers pages
    // globally across the `-o …-p%d.png` template per invocation, so each
    // PDF/PS document is rendered on its own to keep page files from
    // overwriting one another across documents.
    let gsPages = 0;
    for (const doc of job.documents) {
      if (doc.format !== Mime.PDF && doc.format !== Mime.POSTSCRIPT) continue;
      // Offset the page numbering so multiple PDF/PS docs in one job don't
      // collide on `-p<n>.png`; the prefix carries the running page base.
      const docPrefix = gsPages > 0 ? `${prefix}-d${gsPages}` : prefix;
      const written = rasterizePdfOrPostScript(doc.bytes, {
        outPrefix: docPrefix,
        jobId: job.id,
        logger: this.logger,
      });
      gsPages += written.length;
    }

    if (gsPages > 0) {
      this.logger.info('Rasterized PDF/PostScript job via Ghostscript', {
        jobId: job.id,
        pages: gsPages,
      });
      // Best-effort: reflect the real gs page count in job-impressions.
      job.setImpressions(gsPages);
    }
  }

  /**
   * Derive printer-state from job activity, per RFC 8011: `processing` while a
   * job is actively printing, `stopped` if a job is processing-stopped, else
   * `idle`. Merely answering a query is NOT `processing` — that distinction is
   * what a real IPP/AirPrint client (e.g. ipptool, CUPS) expects.
   */
  private liveState(): PrinterStateValue {
    // A paused printer is `stopped` — paused takes precedence over idle. A job
    // mid-processing is driven synchronously (pending → processing → completed
    // in one call), so it can never overlap a paused window.
    if (this.paused) return PrinterStates.STOPPED;
    let stopped = false;
    for (const job of this.queue.list()) {
      if (job.state === JobState.PROCESSING) return PrinterStates.PROCESSING;
      if (job.state === JobState.PROCESSING_STOPPED) stopped = true;
    }
    return stopped ? PrinterStates.STOPPED : this.state;
  }

  /**
   * Live printer-state-reasons (RFC 8011 §5.4.12). `paused` while the printer
   * is paused; otherwise the `none` sentinel (no reasons). Kept in lockstep
   * with liveState() so a `stopped` paused printer reports a matching reason.
   */
  private liveReasons(): string[] {
    return this.paused ? ['paused'] : ['none'];
  }

  /**
   * Decode an IPP request body, dispatch it, and encode the response.
   * Any decode failure becomes a client-error-bad-request response so the
   * caller always gets a valid IPP reply.
   */
  handleRequest(body: Buffer): Buffer {
    let response: IppResponse;
    try {
      const request = decode(body);
      this.logger.protocol(
        'receive',
        `op=0x${request.operationIdOrStatusCode.toString(16).padStart(4, '0')}`,
        `request-id=${request.requestId} groups=${request.groups.length}`
      );
      response = dispatch(request, this.buildContext());
      this.emit('request', request, response);
    } catch (err) {
      this.logger.error(`Failed to decode IPP request: ${(err as Error).message}`);
      response = badRequest();
    }

    this.logger.protocol(
      'send',
      `status=0x${response.operationIdOrStatusCode.toString(16).padStart(4, '0')}`,
      `request-id=${response.requestId}`
    );
    return encode(response);
  }
}

/** A minimal bad-request response used when decode fails. */
function badRequest(): IppResponse {
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: StatusCodes.CLIENT_ERROR_BAD_REQUEST,
    requestId: 0,
    groups: [],
  };
}
