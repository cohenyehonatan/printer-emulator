/**
 * Thin HTTP POST helper for the IPP client.
 *
 * Posts a binary IPP request body to a printer's HTTP endpoint with the
 * application/ipp content type and returns the raw response body. Knows nothing
 * about IPP semantics — encoding/decoding lives in the ipp/ layer. Parses the
 * printer URI (ipp:// or http://) into host/port/path for node's http client.
 */

import { request as httpRequest } from 'http';
import { IPP_CONTENT_TYPE } from '../ipp/constants.js';

export interface ParsedPrinterUri {
  host: string;
  port: number;
  path: string;
}

/** Parse an ipp:// or http:// printer URI into connection parameters. */
export function parsePrinterUri(uri: string): ParsedPrinterUri {
  // Treat ipp:// as http:// for transport purposes (default port 631).
  const normalized = uri.replace(/^ipp:\/\//i, 'http://');
  const u = new URL(normalized);
  const port = u.port ? parseInt(u.port, 10) : 631;
  return {
    host: u.hostname,
    port,
    path: u.pathname === '' ? '/' : u.pathname,
  };
}

/** POST a binary IPP request body and resolve with the binary response body. */
export function postIpp(uri: string, body: Buffer): Promise<Buffer> {
  const { host, port, path } = parsePrinterUri(uri);

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': IPP_CONTENT_TYPE,
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
