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
import { SubscriptionManager } from './subscription-manager.js';
import {
  DEFAULT_IDENTITY,
  type PrinterIdentity,
} from './printer-attributes.js';
import { dispatch, dispatchAsync, type OperationContext } from '../ipp/dispatcher.js';
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
  NotifyEvents,
  JobStates,
  type PrinterStateValue,
  type JobStateValue,
} from '../ipp/constants.js';
import type { IppRequest, IppResponse } from '../ipp/message.js';
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
   * Epoch-ms when this printer object was constructed — the base for
   * printer-up-time (RFC 8011 §5.4.29), reported in seconds.
   */
  private readonly startedAt = Date.now();
  /**
   * Event-notification subscription manager (RFC 3995 / RFC 3996 pull mode).
   * Owns the live subscriptions and per-subscription event queues; fed by the
   * lifecycle event sources (job created/completed/state-changed, printer
   * pause/resume) wired in handleRequest()/recordLifecycleEvents().
   */
  private readonly subscriptions = new SubscriptionManager(() =>
    this.upTimeSeconds()
  );
  /**
   * Whether the printer is paused (Pause-Printer, 0x0010). While paused,
   * liveState() reports `stopped` and the job-running operation paths defer
   * jobs (leaving them `pending`) instead of printing them. Resume-Printer
   * clears the flag and runs the deferred jobs.
   */
  private paused = false;
  /**
   * Whether the printer is accepting new jobs (RFC 8011 §5.4.20,
   * `printer-is-accepting-jobs`). Disable-Printer (RFC 3998, 0x0023) sets this
   * false — the job-creating operations then reject with
   * server-error-not-accepting-jobs (0x0507); Enable-Printer (0x0022) sets it
   * back true. Independent of `paused` (which governs PROCESSING, not admission).
   */
  private accepting = true;
  /**
   * Whether the printer is holding newly submitted jobs (Hold-New-Jobs, RFC
   * 3998, 0x0025). While true, a Print-Job/Create-Job that would otherwise run
   * is instead held (`pending-held`) and the printer advertises the
   * `hold-new-jobs` state-reason. Release-Held-New-Jobs (0x0026) clears it and
   * runs the jobs it held.
   */
  private holdingNewJobs = false;
  /**
   * The ids of jobs that are held SOLELY because they were submitted while
   * `holdingNewJobs` was true. Release-Held-New-Jobs releases exactly these (and
   * nothing held for an explicit `job-hold-until` or an open Create-Job). A job
   * is recorded here by the job-creating paths via markHeldNewJob().
   */
  private readonly heldNewJobIds = new Set<number>();

  constructor(private readonly config: IppPrinterConfig) {
    super();
    this.identity = {
      ...DEFAULT_IDENTITY,
      uri: `ipp://localhost:${config.port}/ipp/print`,
      ...config.identity,
    };
    this.logger = new Logger('PRINTER', config.logLevel ?? 'info');
    this.server = new IppHttpServer(config.port, (body) =>
      this.handleRequestAsync(body)
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
        this.handleRequestAsync(body)
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
      // RFC 3998 printer-administrative state.
      isAcceptingJobs: () => this.accepting,
      enablePrinter: () => this.enablePrinter(),
      disablePrinter: () => this.disablePrinter(),
      isHoldingNewJobs: () => this.holdingNewJobs,
      holdNewJobs: () => this.holdNewJobs(),
      releaseHeldNewJobs: () => this.releaseHeldNewJobs(),
      markHeldNewJob: (jobId: number) => this.heldNewJobIds.add(jobId),
      pausePrinterAfterCurrentJob: () => this.pauseAfterCurrentJob(),
      restartPrinter: () => this.restartPrinter(),
      renderRaster: this.config.rasterOut
        ? (job: Job) => this.renderRaster(job)
        : undefined,
      setPrinterAttributes: (overrides) => this.setPrinterAttributes(overrides),
      subscriptions: this.subscriptions,
      printerUpTime: () => this.upTimeSeconds(),
    };
  }

  /** Seconds since this printer object started — printer-up-time (RFC 8011). */
  private upTimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /** The subscription manager (for inspection/tests). */
  getSubscriptions(): SubscriptionManager {
    return this.subscriptions;
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
   * Enable-Printer (RFC 3998, 0x0022): start accepting new jobs. Idempotent.
   */
  enablePrinter(): void {
    if (this.accepting) return;
    this.accepting = true;
    this.logger.info('Enable-Printer: printer-is-accepting-jobs = true');
  }

  /**
   * Disable-Printer (RFC 3998, 0x0023): stop accepting new jobs. Already-queued
   * jobs are unaffected; new Print-Job/Create-Job submissions are rejected with
   * server-error-not-accepting-jobs (0x0507). Does not change printer-state.
   * Idempotent.
   */
  disablePrinter(): void {
    if (!this.accepting) return;
    this.accepting = false;
    this.logger.info('Disable-Printer: printer-is-accepting-jobs = false');
  }

  /**
   * Hold-New-Jobs (RFC 3998, 0x0025): hold subsequently submitted jobs as
   * `pending-held` and advertise the `hold-new-jobs` state-reason. Idempotent.
   */
  holdNewJobs(): void {
    if (this.holdingNewJobs) return;
    this.holdingNewJobs = true;
    this.logger.info('Hold-New-Jobs: new jobs will be held (pending-held)');
  }

  /**
   * Release-Held-New-Jobs (RFC 3998, 0x0026): leave hold-new-jobs mode and run
   * every job that was held solely because it arrived while holding. Jobs held
   * for an explicit `job-hold-until` (or open Create-Job jobs) are left as-is.
   * Idempotent.
   */
  releaseHeldNewJobs(): void {
    this.holdingNewJobs = false;
    for (const jobId of [...this.heldNewJobIds]) {
      const job = this.queue.get(jobId);
      this.heldNewJobIds.delete(jobId);
      if (!job) continue;
      // release() drives PENDING_HELD → PENDING and (unless paused) runs the
      // emulated print to completion, then renders raster pages if configured.
      if (job.release(this.paused)) {
        if (!this.paused) this.renderRaster(job);
      }
    }
    this.logger.info('Release-Held-New-Jobs: held new jobs released');
  }

  /**
   * Pause-Printer-After-Current-Job (RFC 3998, 0x0024). Jobs run synchronously
   * to completion within their submitting operation, so no job is ever mid-flight
   * here — the "after current job" wait is zero and this reduces to Pause-Printer
   * (printer goes `stopped` immediately). Idempotent.
   */
  pauseAfterCurrentJob(): void {
    this.pause();
  }

  /**
   * Restart-Printer (RFC 3998, 0x0029): reset to a clean running state —
   * accepting jobs, not paused, not holding new jobs, transient state-reasons
   * cleared (→ idle / none). Clearing the paused flag runs any jobs that were
   * deferred `pending` while paused. The job queue is NOT purged; retained jobs
   * (including ones held for an explicit job-hold-until) survive. Note: jobs that
   * were held by Hold-New-Jobs are released and run as part of clearing that mode.
   */
  restartPrinter(): void {
    this.accepting = true;
    this.holdingNewJobs = false;
    // Release any jobs held by hold-new-jobs (clears heldNewJobIds + runs them).
    if (this.heldNewJobIds.size > 0) this.releaseHeldNewJobs();
    // Clear paused last so its runPendingJobs() also runs jobs just released.
    if (this.paused) {
      this.resume();
    } else {
      this.runPendingJobs();
    }
    this.state = PrinterStates.IDLE;
    this.logger.info('Restart-Printer: reset to clean running state (idle)');
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
   * to emit grayscale PNGs even for color pages, `orientation-requested` rotates
   * the decoded PWG/URF page (90°/180°/270°) before encoding, `page-ranges`
   * limits the PWG/URF path to the selected 1-based pages, `number-up` tiles
   * N consecutive pages onto one sheet, `print-quality` scales the output
   * resolution (draft → 0.5× nearest-neighbor downscale; normal/high → full),
   * and `sides=two-sided-short-edge` tumbles each back (even) page 180°.
   * (The Ghostscript PDF/PS path is left in color, unrotated, unfiltered, not
   * N-up'd, not quality-scaled, and not tumbled regardless — gs colour/
   * orientation/range/number-up/quality/sides control isn't threaded here; see
   * README.)
   */
  private renderRaster(job: Job): void {
    const prefix = this.config.rasterOut;
    if (!prefix) return;

    // In-process PWG/URF raster decode. monochrome → force grayscale output;
    // orientation-requested → rotate the decoded page before encoding;
    // sides=two-sided-short-edge → tumble (rotate even/back pages 180°).
    const forceGrayscale = job.printColorMode === 'monochrome';
    renderRasterJob(
      job.documents,
      job.id,
      prefix,
      this.logger,
      forceGrayscale,
      job.orientation,
      job.pageRanges,
      job.numberUp,
      job.printQuality,
      job.sides
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
   * Snapshot the state of every known job (id → numeric job-state) plus the
   * live printer-state, taken just before an operation is dispatched. Compared
   * against the post-dispatch state by recordLifecycleEvents() to derive which
   * notification events to record.
   */
  private snapshotStates(): {
    jobs: Map<number, JobStateValue>;
    printerState: PrinterStateValue;
  } {
    const jobs = new Map<number, JobStateValue>();
    for (const job of this.queue.list()) {
      jobs.set(job.id, job.stateValue);
    }
    return { jobs, printerState: this.liveState() };
  }

  /**
   * Derive and record event-notifications (RFC 3995) by diffing the pre-dispatch
   * snapshot against current state. A job absent from the snapshot is newly
   * created (job-created); a job whose state changed records job-state-changed,
   * plus job-completed when it reached a terminal state (completed/canceled/
   * aborted) and job-stopped when it entered processing-stopped. A change in
   * printer-state records printer-state-changed (and printer-stopped when it
   * became stopped). Feeds the subscription manager, which fans each event out
   * to matching subscriptions. Synchronous — jobs run synchronously.
   */
  private recordLifecycleEvents(before: {
    jobs: Map<number, JobStateValue>;
    printerState: PrinterStateValue;
  }): void {
    // Job events.
    for (const job of this.queue.list()) {
      const prev = before.jobs.get(job.id);
      const now = job.stateValue;

      if (prev === undefined) {
        // A job not in the snapshot is newly created by this operation.
        this.subscriptions.recordEvent({
          event: NotifyEvents.JOB_CREATED,
          jobId: job.id,
          jobState: now,
        });
      }

      if (prev !== now) {
        this.subscriptions.recordEvent({
          event: NotifyEvents.JOB_STATE_CHANGED,
          jobId: job.id,
          jobState: now,
        });
        if (
          now === JobStates.COMPLETED ||
          now === JobStates.CANCELED ||
          now === JobStates.ABORTED
        ) {
          this.subscriptions.recordEvent({
            event: NotifyEvents.JOB_COMPLETED,
            jobId: job.id,
            jobState: now,
          });
        }
        if (now === JobStates.PROCESSING_STOPPED) {
          this.subscriptions.recordEvent({
            event: NotifyEvents.JOB_STOPPED,
            jobId: job.id,
            jobState: now,
          });
        }
      }
    }

    // Printer-state events.
    const printerNow = this.liveState();
    if (printerNow !== before.printerState) {
      this.subscriptions.recordEvent({
        event: NotifyEvents.PRINTER_STATE_CHANGED,
        printerState: printerNow,
      });
      if (printerNow === PrinterStates.STOPPED) {
        this.subscriptions.recordEvent({
          event: NotifyEvents.PRINTER_STOPPED,
          printerState: printerNow,
        });
      }
    }
  }

  /**
   * Decode an IPP request body, dispatch it SYNCHRONOUSLY, and encode the
   * response. Any decode failure becomes a client-error-bad-request response so
   * the caller always gets a valid IPP reply.
   *
   * This is the synchronous path used by unit tests and every operation that
   * completes synchronously. The async Print-URI/Send-URI operations (which
   * fetch a document-uri) are NOT served here — they return
   * server-error-operation-not-supported on this path; the HTTP transport uses
   * handleRequestAsync() instead, which awaits their fetch.
   */
  handleRequest(body: Buffer): Buffer {
    let response: IppResponse;
    try {
      const request = decode(body);
      this.logReceive(request);
      const before = this.snapshotStates();
      response = dispatch(request, this.buildContext());
      this.recordLifecycleEvents(before);
      this.emit('request', request, response);
    } catch (err) {
      this.logger.error(`Failed to decode IPP request: ${(err as Error).message}`);
      response = badRequest();
    }
    this.logSend(response);
    return encode(response);
  }

  /**
   * Async twin of handleRequest used by the HTTP/HTTPS transport: it dispatches
   * via dispatchAsync(), so Print-URI/Send-URI can fetch their loopback-only
   * document-uri before the response is encoded. Every synchronous operation
   * flows through the same path with no behavioral change (dispatchAsync just
   * delegates to the synchronous dispatch for them). Never throws.
   */
  async handleRequestAsync(body: Buffer): Promise<Buffer> {
    let response: IppResponse;
    try {
      const request = decode(body);
      this.logReceive(request);
      // Snapshot job + printer state before dispatch so we can record the
      // event-notifications produced by the operation by diffing afterward.
      const before = this.snapshotStates();
      response = await dispatchAsync(request, this.buildContext());
      this.recordLifecycleEvents(before);
      this.emit('request', request, response);
    } catch (err) {
      this.logger.error(`Failed to decode IPP request: ${(err as Error).message}`);
      response = badRequest();
    }
    this.logSend(response);
    return encode(response);
  }

  private logReceive(request: IppRequest): void {
    this.logger.protocol(
      'receive',
      `op=0x${request.operationIdOrStatusCode.toString(16).padStart(4, '0')}`,
      `request-id=${request.requestId} groups=${request.groups.length}`
    );
  }

  private logSend(response: IppResponse): void {
    this.logger.protocol(
      'send',
      `status=0x${response.operationIdOrStatusCode.toString(16).padStart(4, '0')}`,
      `request-id=${response.requestId}`
    );
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
