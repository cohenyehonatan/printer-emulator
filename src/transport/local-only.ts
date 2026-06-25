/**
 * Shared LOCAL-ONLY URI guard for every OUTBOUND fetch/post the printer makes
 * on a client-supplied URI.
 *
 * ┌─────────────────────────── SECURITY ───────────────────────────────────┐
 * │ Several IPP operations take a client-supplied URI that THIS process then │
 * │ contacts over the network: Print-URI/Send-URI fetch a `document-uri`,    │
 * │ and a PUSH notification subscription posts events to a                   │
 * │ `notify-recipient-uri`. Both are textbook SSRF primitives — an           │
 * │ unrestricted destination lets a remote client make the emulator issue    │
 * │ outbound requests to arbitrary hosts (cloud-metadata endpoints, internal │
 * │ services, port scans, data exfiltration via the URL).                    │
 * │                                                                          │
 * │ This module centralizes the HOST allowlist so every outbound feature     │
 * │ enforces the EXACT SAME rule. An `http://HOST` URI is allowed ONLY when  │
 * │ HOST is exactly one of the literal loopback strings:                     │
 * │                                                                          │
 * │     localhost, 127.0.0.1, ::1, [::1]      (any port)                     │
 * │                                                                          │
 * │ Everything else is refused: https:, ftp:, data:, file:, gopher:, ws: …;  │
 * │ http: to ANY other host (example.com, 169.254.169.254 cloud-metadata,    │
 * │ 0.0.0.0, 10.x, a userinfo spoof like `localhost@evil`, a suffix spoof    │
 * │ like `localhost.evil`, an IDN/percent-encoded spoof of "localhost", or a │
 * │ hostname that merely *resolves* to loopback).                            │
 * │                                                                          │
 * │ The host check is STRING EQUALITY on the parsed, lower-cased URL.hostname │
 * │ — NEVER a DNS lookup. We never resolve hostnames, so there is no          │
 * │ DNS-rebinding / DNS-to-localhost bypass: only the literal strings pass.   │
 * │ URL parsing also defeats userinfo/suffix spoofs — `localhost@evil`        │
 * │ parses to hostname `evil`, and `localhost.evil` is hostname              │
 * │ `localhost.evil`; neither equals a literal, so both are refused.         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

/**
 * The literal http hosts an outbound request may contact. String equality only
 * — no DNS resolution, so a hostname that merely resolves to loopback never
 * passes. (URL.hostname strips the brackets from an IPv6 literal, so `[::1]`
 * arrives as `::1`; isAllowedHttpHost accepts both spellings.)
 */
export const ALLOWED_HTTP_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

/** Whether `host` is one of the literal allowlisted loopback names. */
export function isAllowedHttpHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
  );
}

/**
 * Whether `uri` is an outbound destination this process is permitted to contact:
 * an `http:` URI whose parsed hostname is exactly a loopback literal (any port).
 * Anything that does not parse, any non-http scheme, and any non-loopback host
 * returns false. STRING-EQUALITY host check only — never a DNS lookup. See the
 * SECURITY block above.
 */
export function isLocalOnlyHttpUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol.toLowerCase() !== 'http:') return false;
  return isAllowedHttpHost(parsed.hostname);
}
