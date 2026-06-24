/**
 * IPP client — the "host" side that drives a printer.
 *
 * Builds IPP requests via the encoder, POSTs them over HTTP, and decodes the
 * binary responses. This is the client analog of pectab's DcsHost: high-level
 * verbs (getPrinterAttributes, printJob, getJobs) that hide the binary codec.
 * Each request carries the mandatory operation attributes (charset,
 * natural-language, printer-uri) per RFC 8011.
 */

import { Logger } from '../logging/logger.js';
import { encode } from '../ipp/encoder.js';
import { decode } from '../ipp/decoder.js';
import { postIpp } from '../transport/http-client.js';
import {
  OperationIds,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
} from '../ipp/constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  uriAttr,
  nameWithoutLangAttr,
  mimeMediaTypeAttr,
  keywordAttr,
  integerAttr,
  booleanAttr,
  type IppAttribute,
} from '../ipp/attribute.js';
import {
  operationGroup,
  type IppRequest,
  type IppResponse,
} from '../ipp/message.js';

export interface IppClientConfig {
  printerUri: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export class IppClient {
  private readonly logger: Logger;
  private requestId = 1;

  constructor(private readonly config: IppClientConfig) {
    this.logger = new Logger('CLIENT', config.logLevel ?? 'info');
  }

  /**
   * Get-Printer-Attributes round trip. Pass `requestedAttributes` to sub-select
   * which printer attributes come back; defaults to `all`.
   */
  async getPrinterAttributes(
    requestedAttributes: string[] = ['all']
  ): Promise<IppResponse> {
    const request = this.baseRequest(OperationIds.GET_PRINTER_ATTRIBUTES, [
      keywordAttr('requested-attributes', ...requestedAttributes),
    ]);
    return this.send(request);
  }

  /** Validate-Job pre-flight. */
  async validateJob(format = 'application/octet-stream'): Promise<IppResponse> {
    const request = this.baseRequest(OperationIds.VALIDATE_JOB, [
      mimeMediaTypeAttr('document-format', format),
    ]);
    return this.send(request);
  }

  /** Print-Job: submit document bytes with a declared format. */
  async printJob(
    docBytes: Buffer,
    format = 'application/octet-stream',
    jobName = 'print-job'
  ): Promise<IppResponse> {
    const request = this.baseRequest(OperationIds.PRINT_JOB, [
      nameWithoutLangAttr('job-name', jobName),
      mimeMediaTypeAttr('document-format', format),
    ]);
    request.data = docBytes;
    return this.send(request);
  }

  /**
   * Get-Jobs: list jobs on the printer. Optionally filter by `whichJobs`
   * (not-completed / completed / all), cap the result count with `limit`, and
   * sub-select the per-job attributes with `requestedAttributes`.
   */
  async getJobs(
    options: {
      limit?: number;
      whichJobs?: string;
      requestedAttributes?: string[];
    } = {}
  ): Promise<IppResponse> {
    const { limit, whichJobs = 'not-completed', requestedAttributes } = options;
    const opAttrs: IppAttribute[] = [keywordAttr('which-jobs', whichJobs)];
    if (limit !== undefined) {
      opAttrs.push(integerAttr('limit', limit));
    }
    if (requestedAttributes && requestedAttributes.length > 0) {
      opAttrs.push(keywordAttr('requested-attributes', ...requestedAttributes));
    }
    const request = this.baseRequest(OperationIds.GET_JOBS, opAttrs);
    return this.send(request);
  }

  /**
   * Get-Job-Attributes: fetch the attributes of a single job by id. Pass
   * `requestedAttributes` to sub-select which job attributes come back.
   */
  async getJobAttributes(
    jobId: number,
    requestedAttributes?: string[]
  ): Promise<IppResponse> {
    const opAttrs: IppAttribute[] = [integerAttr('job-id', jobId)];
    if (requestedAttributes && requestedAttributes.length > 0) {
      opAttrs.push(keywordAttr('requested-attributes', ...requestedAttributes));
    }
    const request = this.baseRequest(OperationIds.GET_JOB_ATTRIBUTES, opAttrs);
    return this.send(request);
  }

  /**
   * Create-Job: open a multi-document job with no data yet (pending-held).
   * The returned response carries the allocated job-id; follow with one or more
   * sendDocument() calls and a closeJob() (or a final last-document).
   */
  async createJob(
    options: { jobName?: string } = {}
  ): Promise<IppResponse> {
    const opAttrs: IppAttribute[] = [];
    if (options.jobName !== undefined) {
      opAttrs.push(nameWithoutLangAttr('job-name', options.jobName));
    }
    const request = this.baseRequest(OperationIds.CREATE_JOB, opAttrs);
    return this.send(request);
  }

  /**
   * Send-Document: append a document to an open Create-Job job. Set
   * `lastDocument` to release the job and run the emulated print.
   */
  async sendDocument(
    jobId: number,
    docBytes: Buffer,
    options: {
      format?: string;
      lastDocument?: boolean;
      documentNumber?: number;
    } = {}
  ): Promise<IppResponse> {
    const {
      format = 'application/octet-stream',
      lastDocument = false,
      documentNumber,
    } = options;
    const opAttrs: IppAttribute[] = [
      integerAttr('job-id', jobId),
      mimeMediaTypeAttr('document-format', format),
      booleanAttr('last-document', lastDocument),
    ];
    if (documentNumber !== undefined) {
      opAttrs.push(integerAttr('document-number', documentNumber));
    }
    const request = this.baseRequest(OperationIds.SEND_DOCUMENT, opAttrs);
    request.data = docBytes;
    return this.send(request);
  }

  /**
   * Close-Job: close an open Create-Job job (equivalent to last-document with
   * no further data), releasing/running it if documents were sent.
   */
  async closeJob(jobId: number): Promise<IppResponse> {
    const request = this.baseRequest(OperationIds.CLOSE_JOB, [
      integerAttr('job-id', jobId),
    ]);
    return this.send(request);
  }

  /**
   * Hold-Job: place a pending job into pending-held so it will not print until
   * a matching releaseJob(). A job already held is left held.
   */
  async holdJob(jobId: number): Promise<IppResponse> {
    const request = this.baseRequest(OperationIds.HOLD_JOB, [
      integerAttr('job-id', jobId),
    ]);
    return this.send(request);
  }

  /**
   * Release-Job: release a pending-held job back to pending and run the
   * emulated print. Releasing a job that is not held is a successful no-op.
   */
  async releaseJob(jobId: number): Promise<IppResponse> {
    const request = this.baseRequest(OperationIds.RELEASE_JOB, [
      integerAttr('job-id', jobId),
    ]);
    return this.send(request);
  }

  // ── Internal ────────────────────────────────────────────────────────

  /** Build a request with the mandatory operation attributes. */
  private baseRequest(
    operationId: number,
    extraOpAttrs: IppAttribute[] = []
  ): IppRequest {
    return {
      versionMajor: IPP_VERSION_MAJOR,
      versionMinor: IPP_VERSION_MINOR,
      operationIdOrStatusCode: operationId,
      requestId: this.requestId++,
      groups: [
        operationGroup([
          charsetAttr('attributes-charset', DEFAULT_CHARSET),
          naturalLanguageAttr(
            'attributes-natural-language',
            DEFAULT_NATURAL_LANGUAGE
          ),
          uriAttr('printer-uri', this.config.printerUri),
          ...extraOpAttrs,
        ]),
      ],
    };
  }

  private async send(request: IppRequest): Promise<IppResponse> {
    this.logger.protocol(
      'send',
      `op=0x${request.operationIdOrStatusCode.toString(16).padStart(4, '0')}`,
      `request-id=${request.requestId}`
    );
    const responseBody = await postIpp(this.config.printerUri, encode(request));
    const response = decode(responseBody);
    this.logger.protocol(
      'receive',
      `status=0x${response.operationIdOrStatusCode.toString(16).padStart(4, '0')}`,
      `request-id=${response.requestId} groups=${response.groups.length}`
    );
    return response;
  }
}
