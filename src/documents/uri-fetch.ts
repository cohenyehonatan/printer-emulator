/**
 * Local-only document URI fetcher for Print-URI / Send-URI.
 *
 * ┌─────────────────────────── SECURITY ───────────────────────────────────┐
 * │ Print-URI (0x0003) and Send-URI (0x0007) tell the PRINTER to fetch a    │
 * │ client-supplied `document-uri`. That is a textbook SSRF primitive: an   │
 * │ unrestricted fetch lets a remote client make THIS process issue         │
 * │ outbound requests to arbitrary hosts (cloud metadata endpoints, internal│
 * │ services, port scans, data exfiltration via the URL).                   │
 * │                                                                         │
 * │ This fetcher is therefore HARD-RESTRICTED to LOCAL-ONLY sources. The    │
 * │ ONLY URIs it will ever retrieve are:                                    │
 * │                                                                         │
 * │   1. file://         — a local filesystem path (file:///abs/path).      │
 * │   2. http://HOST     — ONLY when HOST is exactly one of the literal     │
 * │                        allowlist strings: localhost, 127.0.0.1, [::1].  │
 * │                        Any port is allowed.                             │
 * │                                                                         │
 * │ EVERYTHING else is refused with reason 'scheme':                        │
 * │   - https:, ftp:, gopher:, data:, blob:, ws:, file: to a remote host…   │
 * │   - http: to ANY other host (example.com, 169.254.169.254, 0.0.0.0,     │
 * │     10.x, a hostname that *resolves* to localhost, an IDN/percent-      │
 * │     encoded spoof of "localhost", etc.).                                │
 * │                                                                         │
 * │ The host check is a STRING-EQUALITY allowlist on the parsed, lower-     │
 * │ cased URL.hostname — NOT a DNS lookup. We never resolve hostnames, so   │
 * │ there is no DNS-rebinding / DNS-to-localhost bypass: only the three     │
 * │ literal strings pass. Redirects are NOT followed at all (any 3xx is     │
 * │ treated as an access error), so a localhost endpoint cannot bounce the  │
 * │ fetch to a non-local target. A short timeout and a hard streaming size  │
 * │ cap bound the request. This function never throws — every failure maps  │
 * │ to a reason a caller turns into the right IPP status code.              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { get as httpGet, type IncomingMessage } from 'http';

/** Maximum fetched document size (bytes). Larger ⇒ reason 'too-large'. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // 20 MB

/** How long (ms) a localhost http fetch may take before it's an access error. */
export const HTTP_FETCH_TIMEOUT_MS = 5000;

/**
 * The literal http hosts this fetcher will contact. String equality only — no
 * DNS resolution, so a hostname that merely resolves to loopback never passes.
 * (URL.hostname strips the brackets from an IPv6 literal, so `[::1]` arrives as
 * `::1`; isAllowedHttpHost accepts both spellings.)
 */
export const ALLOWED_HTTP_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

/**
 * Result of a local-only fetch attempt. `ok:false` carries a coarse reason the
 * IPP layer maps to a status code:
 *   - 'scheme'    → client-error-uri-scheme-not-supported (non-local URI).
 *   - 'access'    → client-error-document-access-error (couldn't retrieve).
 *   - 'too-large' → client-error-request-entity-too-large (over the cap).
 */
export type FetchResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'scheme' | 'access' | 'too-large' };

/**
 * Fetch a document from a LOCAL-ONLY URI. See the SECURITY block above for the
 * exact allowlist and the anti-SSRF guarantees. Async (the http branch awaits
 * the network), but `file://` resolves synchronously inside. Never throws.
 */
export async function fetchLocalDocument(uri: string): Promise<FetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    // Not a parseable absolute URI — refuse as an unsupported scheme.
    return { ok: false, reason: 'scheme' };
  }

  const scheme = parsed.protocol.toLowerCase();

  if (scheme === 'file:') {
    return fetchFile(parsed);
  }

  if (scheme === 'http:') {
    // Host allowlist is literal string equality on the lower-cased hostname.
    // No DNS lookup ⇒ no rebinding bypass; only the loopback literals pass.
    const host = parsed.hostname.toLowerCase();
    if (!isAllowedHttpHost(host)) {
      return { ok: false, reason: 'scheme' };
    }
    return fetchLocalHttp(parsed);
  }

  // Every other scheme (https, ftp, data, gopher, ws, …) is refused outright.
  return { ok: false, reason: 'scheme' };
}

/** Whether `host` is one of the literal allowlisted loopback names. */
function isAllowedHttpHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

/** Read a local file:// path; never throws. */
function fetchFile(parsed: URL): FetchResult {
  // A file:// URI with a non-empty host is a remote UNC-style reference, not a
  // local path — refuse it as an unsupported scheme. Only `file:///abs` (empty
  // host) or the localhost spelling resolve to a local path.
  const host = parsed.hostname.toLowerCase();
  if (host !== '' && host !== 'localhost') {
    return { ok: false, reason: 'scheme' };
  }

  let path: string;
  try {
    path = fileURLToPath(parsed);
  } catch {
    return { ok: false, reason: 'access' };
  }

  try {
    const st = statSync(path);
    if (st.isDirectory()) {
      // A directory is not a document.
      return { ok: false, reason: 'access' };
    }
    if (st.size > MAX_DOCUMENT_BYTES) {
      return { ok: false, reason: 'too-large' };
    }
  } catch {
    // Missing / unreadable path.
    return { ok: false, reason: 'access' };
  }

  try {
    const bytes = readFileSync(path);
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      return { ok: false, reason: 'too-large' };
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: 'access' };
  }
}

/**
 * Fetch an http://localhost URL. The caller already verified the host is on the
 * loopback allowlist; this performs the actual GET with the security policy:
 *   - NO redirect following — any 3xx is an access error (a localhost endpoint
 *     could otherwise bounce the fetch to a non-local Location).
 *   - a streaming size cap — the response is aborted the moment it exceeds the
 *     cap (reason 'too-large'); the body is never fully buffered past the cap.
 *   - a short socket timeout.
 * Resolves (never rejects) to a FetchResult.
 */
function fetchLocalHttp(parsed: URL): Promise<FetchResult> {
  return new Promise<FetchResult>((resolve) => {
    let settled = false;
    const finish = (r: FetchResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const req = httpGet(
      {
        protocol: 'http:',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        timeout: HTTP_FETCH_TIMEOUT_MS,
      },
      (res: IncomingMessage) => {
        const code = res.statusCode ?? 0;
        // Refuse redirects outright — do not chase a Location to a non-local
        // target. Any non-2xx is an access error.
        if (code < 200 || code >= 300) {
          res.destroy();
          finish({ ok: false, reason: 'access' });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let overflow = false;
        res.on('data', (c: Buffer) => {
          if (overflow) return;
          total += c.length;
          if (total > MAX_DOCUMENT_BYTES) {
            overflow = true;
            res.destroy();
            finish({ ok: false, reason: 'too-large' });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (!overflow) finish({ ok: true, bytes: Buffer.concat(chunks) });
        });
        res.on('error', () => finish({ ok: false, reason: 'access' }));
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, reason: 'access' });
    });
    req.on('error', () => finish({ ok: false, reason: 'access' }));
  });
}
