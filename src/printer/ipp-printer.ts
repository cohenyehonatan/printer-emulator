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
import { MdnsAdvertiser } from '../transport/mdns.js';
import {
  PrinterStates,
  StatusCodes,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
  type PrinterStateValue,
} from '../ipp/constants.js';
import type { IppResponse } from '../ipp/message.js';

export interface IppPrinterConfig {
  port: number;
  identity?: Partial<PrinterIdentity>;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Advertise the printer over mDNS/DNS-SD (AirPrint discovery). Defaults to
   * true; tests/CI and in-process demos set it false to avoid leaving a
   * multicast socket open that would block clean process exit.
   */
  advertise?: boolean;
  /** Hostname used in the mDNS adminurl TXT key. Defaults to 'localhost'. */
  host?: string;
}

export class IppPrinter extends EventEmitter {
  readonly identity: PrinterIdentity;
  private readonly queue = new JobQueue();
  private readonly logger: Logger;
  private readonly server: IppHttpServer;
  private mdns: MdnsAdvertiser | null = null;
  private state: PrinterStateValue = PrinterStates.IDLE;

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

    // Advertise over mDNS once the HTTP server is accepting connections.
    if (this.config.advertise ?? true) {
      this.mdns = new MdnsAdvertiser({
        identity: this.identity,
        port: this.config.port,
        host: this.config.host,
      });
      this.mdns.start();
    }

    this.emit('started');
  }

  /** Stop mDNS advertising (if any) and the HTTP/IPP server. */
  async stop(): Promise<void> {
    if (this.mdns) {
      await this.mdns.stop();
      this.mdns = null;
    }
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
      printerState: () => this.liveState(),
    };
  }

  /**
   * Derive printer-state from job activity, per RFC 8011: `processing` while a
   * job is actively printing, `stopped` if a job is processing-stopped, else
   * `idle`. Merely answering a query is NOT `processing` — that distinction is
   * what a real IPP/AirPrint client (e.g. ipptool, CUPS) expects.
   */
  private liveState(): PrinterStateValue {
    let stopped = false;
    for (const job of this.queue.list()) {
      if (job.state === JobState.PROCESSING) return PrinterStates.PROCESSING;
      if (job.state === JobState.PROCESSING_STOPPED) stopped = true;
    }
    return stopped ? PrinterStates.STOPPED : this.state;
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
