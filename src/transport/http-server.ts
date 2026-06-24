/**
 * IPP-over-HTTP server (RFC 8010 §4 transport binding).
 *
 * IPP rides on HTTP POST with Content-Type application/ipp. This thin wrapper
 * over node's `http` module collects the request body, hands it to the IPP
 * request handler (decode -> dispatch -> encode), and writes the binary IPP
 * response back with the application/ipp content type. Non-IPP requests get a
 * 400; GET on the printer path gets a friendly text banner.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { IPP_CONTENT_TYPE } from '../ipp/constants.js';

export type IppRequestHandler = (body: Buffer) => Buffer;

export class IppHttpServer {
  private server: Server | null = null;

  constructor(
    private readonly port: number,
    private readonly handler: IppRequestHandler
  ) {}

  /** Begin listening on the configured port. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.onRequest(req, res));
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        this.server?.removeListener('error', reject);
        resolve();
      });
    });
  }

  /** Stop listening and close all connections. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('printer-emulator: POST application/ipp to this endpoint.\n');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed\n');
      return;
    }

    const contentType = (req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.includes(IPP_CONTENT_TYPE)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Expected Content-Type: ${IPP_CONTENT_TYPE}\n`);
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let responseBody: Buffer;
      try {
        responseBody = this.handler(Buffer.concat(chunks));
      } catch {
        // The handler is contracted never to throw, but guard the socket anyway.
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal IPP error\n');
        return;
      }
      res.writeHead(200, {
        'Content-Type': IPP_CONTENT_TYPE,
        'Content-Length': responseBody.length,
      });
      res.end(responseBody);
    });
    req.on('error', () => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request\n');
    });
  }
}
