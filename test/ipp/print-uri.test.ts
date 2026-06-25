import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createServer, type Server } from 'http';
import {
  OperationIds,
  StatusCodes,
  JobStates,
  PrinterStates,
  DelimiterTags,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
} from '../../src/ipp/constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  integerAttr,
  booleanAttr,
  uriAttr,
  mimeMediaTypeAttr,
  findAttr,
  firstNumber,
  allStrings,
  type IppAttribute,
} from '../../src/ipp/attribute.js';
import {
  operationGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../../src/ipp/message.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import {
  dispatch,
  dispatchAsync,
  type OperationContext,
} from '../../src/ipp/dispatcher.js';
import { JobQueue } from '../../src/printer/job-queue.js';
import { DEFAULT_IDENTITY, buildPrinterAttributes } from '../../src/printer/printer-attributes.js';
import {
  fetchLocalDocument,
  MAX_DOCUMENT_BYTES,
} from '../../src/documents/uri-fetch.js';

// ── Temp fixtures ───────────────────────────────────────────────────────────

let tmpDir: string;
let pdfPath: string;
let textPath: string;
let bigPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'print-uri-'));
  pdfPath = join(tmpDir, 'doc.pdf');
  textPath = join(tmpDir, 'doc.txt');
  bigPath = join(tmpDir, 'big.bin');
  writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n% test document\n'));
  writeFileSync(textPath, Buffer.from('hello world\n'));
  // One byte over the cap → 'too-large'.
  writeFileSync(bigPath, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x41));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Request helpers ─────────────────────────────────────────────────────────

function makeContext(queue: JobQueue): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue,
    printerState: () => PrinterStates.IDLE,
  };
}

function request(
  operationId: number,
  extraOpAttrs: IppAttribute[]
): IppRequest {
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: operationId,
    requestId: 1,
    groups: [
      operationGroup([
        charsetAttr('attributes-charset', DEFAULT_CHARSET),
        naturalLanguageAttr(
          'attributes-natural-language',
          DEFAULT_NATURAL_LANGUAGE
        ),
        ...extraOpAttrs,
      ]),
    ],
  };
}

/** Synchronous round trip for non-URI ops (Create-Job, Get-Job-Attributes). */
function roundTrip(req: IppRequest, ctx: OperationContext): IppResponse {
  return dispatch(decode(encode(req)), ctx);
}

/** Async round trip used for Print-URI / Send-URI (they fetch a document-uri). */
async function roundTripAsync(
  req: IppRequest,
  ctx: OperationContext
): Promise<IppResponse> {
  return dispatchAsync(decode(encode(req)), ctx);
}

function jobAttrsOf(response: IppResponse): IppAttribute[] {
  return getGroupAttributes(
    decode(encode(response)),
    DelimiterTags.JOB_ATTRIBUTES
  );
}

// ── fetchLocalDocument: local-only allowlist ────────────────────────────────

describe('fetchLocalDocument (LOCAL-ONLY allowlist)', () => {
  it('file:// to a real file returns its bytes', async () => {
    const res = await fetchLocalDocument(pathToFileURL(textPath).href);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bytes.toString()).toBe('hello world\n');
  });

  it('file:// to a missing file → access', async () => {
    const missing = pathToFileURL(join(tmpDir, 'nope.pdf')).href;
    const res = await fetchLocalDocument(missing);
    expect(res).toEqual({ ok: false, reason: 'access' });
  });

  it('file:// to a directory → access', async () => {
    const res = await fetchLocalDocument(pathToFileURL(tmpDir).href);
    expect(res).toEqual({ ok: false, reason: 'access' });
  });

  it('file:// over the size cap → too-large', async () => {
    const res = await fetchLocalDocument(pathToFileURL(bigPath).href);
    expect(res).toEqual({ ok: false, reason: 'too-large' });
  });

  it('file:// with a remote host → scheme (no UNC fetch)', async () => {
    const res = await fetchLocalDocument('file://evil.example/etc/passwd');
    expect(res).toEqual({ ok: false, reason: 'scheme' });
  });

  it('http://example.com → scheme (non-local host refused)', async () => {
    const res = await fetchLocalDocument('http://example.com/x');
    expect(res).toEqual({ ok: false, reason: 'scheme' });
  });

  it('http to a non-local IP → scheme (cloud-metadata SSRF blocked)', async () => {
    const res = await fetchLocalDocument(
      'http://169.254.169.254/latest/meta-data/'
    );
    expect(res).toEqual({ ok: false, reason: 'scheme' });
  });

  it('https://localhost → scheme (https not allowed even for localhost)', async () => {
    const res = await fetchLocalDocument('https://localhost/x');
    expect(res).toEqual({ ok: false, reason: 'scheme' });
  });

  it('userinfo spoof http://localhost@evil.example → scheme', async () => {
    // The real hostname here is evil.example; the `localhost@` is userinfo.
    const res = await fetchLocalDocument('http://localhost@evil.example/x');
    expect(res).toEqual({ ok: false, reason: 'scheme' });
  });

  it('suffix spoof http://localhost.evil.example → scheme', async () => {
    const res = await fetchLocalDocument('http://localhost.evil.example/x');
    expect(res).toEqual({ ok: false, reason: 'scheme' });
  });

  it('ftp:// → scheme', async () => {
    const res = await fetchLocalDocument('ftp://localhost/x');
    expect(res).toEqual({ ok: false, reason: 'scheme' });
  });

  it('data: URI → scheme', async () => {
    const res = await fetchLocalDocument('data:text/plain;base64,aGVsbG8=');
    expect(res).toEqual({ ok: false, reason: 'scheme' });
  });

  it('unparseable URI → scheme', async () => {
    const res = await fetchLocalDocument('not a uri at all');
    expect(res).toEqual({ ok: false, reason: 'scheme' });
  });
});

// ── fetchLocalDocument: http://localhost happy path (real local server) ─────
// The fetch is async (plain http.get), so an in-process loopback fixture server
// serves it fine. The server is closed in afterAll so the run self-exits with no
// leaked handle.

describe('fetchLocalDocument (http://localhost)', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://example.com/elsewhere' });
        res.end();
        return;
      }
      if (req.url === '/fail') {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('local http body');
    });
    // Listen on the IPv4 loopback explicitly. The fetcher reaches it via the
    // 127.0.0.1 literal; the `localhost` host tests resolve to it on this host.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('http://127.0.0.1:PORT/doc is fetched', async () => {
    const res = await fetchLocalDocument(`http://127.0.0.1:${port}/doc`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bytes.toString()).toBe('local http body');
  });

  it('http://localhost:PORT/doc is fetched', async () => {
    const res = await fetchLocalDocument(`http://localhost:${port}/doc`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bytes.toString()).toBe('local http body');
  });

  it('a 3xx redirect (even from localhost) is NOT followed → access', async () => {
    const res = await fetchLocalDocument(`http://127.0.0.1:${port}/redirect`);
    expect(res).toEqual({ ok: false, reason: 'access' });
  });

  it('an http error status → access', async () => {
    const res = await fetchLocalDocument(`http://127.0.0.1:${port}/fail`);
    expect(res).toEqual({ ok: false, reason: 'access' });
  });

  it('http://localhost served document Prints end-to-end', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const res = await roundTripAsync(
      request(OperationIds.PRINT_URI, [
        uriAttr('document-uri', `http://127.0.0.1:${port}/doc`),
      ]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(res), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
  });
});

// ── Print-URI operation ──────────────────────────────────────────────────────

describe('Print-URI (0x0003)', () => {
  it('file:// PDF → job created + completed', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const res = await roundTripAsync(
      request(OperationIds.PRINT_URI, [
        uriAttr('document-uri', pathToFileURL(pdfPath).href),
      ]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const attrs = jobAttrsOf(res);
    const jobId = firstNumber(findAttr(attrs, 'job-id'));
    expect(jobId).toBeDefined();
    expect(firstNumber(findAttr(attrs, 'job-state'))).toBe(JobStates.COMPLETED);
    expect(queue.get(jobId!)!.document!.format).toBe('application/pdf');
  });

  it('file:// text document → job created + completed', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const res = await roundTripAsync(
      request(OperationIds.PRINT_URI, [
        uriAttr('document-uri', pathToFileURL(textPath).href),
      ]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(res), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
  });

  it('disallowed external URI → client-error-uri-scheme-not-supported', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const res = await roundTripAsync(
      request(OperationIds.PRINT_URI, [
        uriAttr('document-uri', 'http://evil.example/secret'),
      ]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_URI_SCHEME_NOT_SUPPORTED
    );
    // No job was created.
    expect(queue.size()).toBe(0);
    expect(jobAttrsOf(res)).toHaveLength(0);
  });

  it('https://localhost → client-error-uri-scheme-not-supported', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const res = await roundTripAsync(
      request(OperationIds.PRINT_URI, [
        uriAttr('document-uri', 'https://localhost/x'),
      ]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_URI_SCHEME_NOT_SUPPORTED
    );
  });

  it('missing file:// → client-error-document-access-error', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const res = await roundTripAsync(
      request(OperationIds.PRINT_URI, [
        uriAttr('document-uri', pathToFileURL(join(tmpDir, 'gone.pdf')).href),
      ]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_DOCUMENT_ACCESS_ERROR
    );
    expect(queue.size()).toBe(0);
  });

  it('over-cap file:// → client-error-request-entity-too-large', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const res = await roundTripAsync(
      request(OperationIds.PRINT_URI, [
        uriAttr('document-uri', pathToFileURL(bigPath).href),
      ]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_REQUEST_ENTITY_TOO_LARGE
    );
  });

  it('Print-URI with no document-uri → client-error-bad-request', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const res = await roundTripAsync(request(OperationIds.PRINT_URI, []), ctx);
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_BAD_REQUEST
    );
  });
});

// ── Send-URI operation ───────────────────────────────────────────────────────

describe('Send-URI (0x0007)', () => {
  it('Create-Job → Send-URI(last) appends and runs', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);

    const created = roundTrip(request(OperationIds.CREATE_JOB, []), ctx);
    const jobId = firstNumber(findAttr(jobAttrsOf(created), 'job-id'))!;

    const sent = await roundTripAsync(
      request(OperationIds.SEND_URI, [
        integerAttr('job-id', jobId),
        uriAttr('document-uri', pathToFileURL(pdfPath).href),
        booleanAttr('last-document', true),
      ]),
      ctx
    );
    expect(sent.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(firstNumber(findAttr(jobAttrsOf(sent), 'job-state'))).toBe(
      JobStates.COMPLETED
    );
    const job = queue.get(jobId)!;
    expect(job.documents).toHaveLength(1);
    expect(job.document!.format).toBe('application/pdf');
  });

  it('Send-URI to an unknown job → client-error-not-found', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const res = await roundTripAsync(
      request(OperationIds.SEND_URI, [
        integerAttr('job-id', 9999),
        uriAttr('document-uri', pathToFileURL(pdfPath).href),
        booleanAttr('last-document', true),
      ]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.CLIENT_ERROR_NOT_FOUND);
  });

  it('Send-URI with a disallowed URI → uri-scheme-not-supported, job untouched', async () => {
    const queue = new JobQueue();
    const ctx = makeContext(queue);
    const created = roundTrip(request(OperationIds.CREATE_JOB, []), ctx);
    const jobId = firstNumber(findAttr(jobAttrsOf(created), 'job-id'))!;

    const res = await roundTripAsync(
      request(OperationIds.SEND_URI, [
        integerAttr('job-id', jobId),
        uriAttr('document-uri', 'http://evil.example/x'),
        booleanAttr('last-document', true),
      ]),
      ctx
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_URI_SCHEME_NOT_SUPPORTED
    );
    const job = queue.get(jobId)!;
    expect(job.documents).toHaveLength(0);
    expect(job.isOpen).toBe(true);
  });
});

// ── Printer attribute advertisement ──────────────────────────────────────────

describe('printer-attributes advertises Print-URI / Send-URI', () => {
  it('operations-supported includes 0x0003 and 0x0007', () => {
    const attrs = buildPrinterAttributes(DEFAULT_IDENTITY);
    const ops = findAttr(attrs, 'operations-supported');
    const values = ops!.values.map((v) => v.value);
    expect(values).toContain(OperationIds.PRINT_URI);
    expect(values).toContain(OperationIds.SEND_URI);
  });

  it('document-uri-schemes-supported = [file, http]', () => {
    const attrs = buildPrinterAttributes(DEFAULT_IDENTITY);
    expect(allStrings(findAttr(attrs, 'document-uri-schemes-supported'))).toEqual(
      ['file', 'http']
    );
    expect(
      allStrings(findAttr(attrs, 'reference-uri-schemes-supported'))
    ).toEqual(['file', 'http']);
  });
});
