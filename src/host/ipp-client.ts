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

  /** Get-Printer-Attributes round trip. */
  async getPrinterAttributes(): Promise<IppResponse> {
    const request = this.baseRequest(OperationIds.GET_PRINTER_ATTRIBUTES, [
      keywordAttr('requested-attributes', 'all'),
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

  /** Get-Jobs: list jobs on the printer. */
  async getJobs(): Promise<IppResponse> {
    const request = this.baseRequest(OperationIds.GET_JOBS, [
      keywordAttr('which-jobs', 'not-completed'),
    ]);
    return this.send(request);
  }

  /** Get-Job-Attributes: fetch the attributes of a single job by id. */
  async getJobAttributes(jobId: number): Promise<IppResponse> {
    const request = this.baseRequest(OperationIds.GET_JOB_ATTRIBUTES, [
      integerAttr('job-id', jobId),
    ]);
    return this.send(request);
  }

  // ── Internal ────────────────────────────────────────────────────────

  /** Build a request with the mandatory operation attributes. */
  private baseRequest(
    operationId: number,
    extraOpAttrs: ReturnType<typeof keywordAttr>[] = []
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
