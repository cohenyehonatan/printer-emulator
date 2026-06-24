import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request as httpsRequest } from 'https';
import type { AddressInfo } from 'net';
import { IppHttpsServer } from '../../src/transport/https-server.js';
import { ensureSelfSignedCert } from '../../src/transport/tls-cert.js';
import { Logger } from '../../src/logging/logger.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import {
  OperationIds,
  StatusCodes,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
  IPP_CONTENT_TYPE,
} from '../../src/ipp/constants.js';
import { operationGroup, type IppRequest } from '../../src/ipp/message.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  uriAttr,
} from '../../src/ipp/attribute.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const OPENSSL = hasOpenssl();
const logger = new Logger('TEST', 'error');

/** POST an application/ipp body over HTTPS, resolving the binary response. */
function ippsPost(port: number, body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/ipp/print',
        rejectUnauthorized: false, // self-signed emulator cert
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
    req.end(body);
  });
}

describe.skipIf(!OPENSSL)('IppHttpsServer (IPPS round-trip)', () => {
  const dirs: string[] = [];
  let server: IppHttpsServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('serves an IPP request over TLS and round-trips the response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'printer-emu-https-'));
    dirs.push(dir);
    const cert = ensureSelfSignedCert(dir, logger);
    expect(cert).not.toBeNull();

    // Echo-ish handler: decode the request, reply successful-ok with the same
    // request-id — exercises real decode + encode through the TLS transport.
    const handler = (body: Buffer): Buffer => {
      const req = decode(body);
      return encode({
        versionMajor: IPP_VERSION_MAJOR,
        versionMinor: IPP_VERSION_MINOR,
        operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
        requestId: req.requestId,
        groups: [operationGroup([charsetAttr('attributes-charset', 'utf-8')])],
      });
    };

    server = new IppHttpsServer(
      0,
      {
        cert: readFileSync(cert!.certPath),
        key: readFileSync(cert!.keyPath),
      },
      handler
    );
    await server.listen();
    // Read the ephemeral port the OS assigned.
    const port = ((server as unknown as { server: { address(): AddressInfo } })
      .server.address()).port;

    const request: IppRequest = {
      versionMajor: IPP_VERSION_MAJOR,
      versionMinor: IPP_VERSION_MINOR,
      operationIdOrStatusCode: OperationIds.GET_PRINTER_ATTRIBUTES,
      requestId: 0x2a,
      groups: [
        operationGroup([
          charsetAttr('attributes-charset', 'utf-8'),
          naturalLanguageAttr('attributes-natural-language', 'en'),
          uriAttr('printer-uri', 'ipps://127.0.0.1/ipp/print'),
        ]),
      ],
    };

    const responseBytes = await ippsPost(port, encode(request));
    const decoded = decode(responseBytes);

    expect(decoded.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(decoded.requestId).toBe(0x2a);

    await server.close();
    server = null;
  });
});
