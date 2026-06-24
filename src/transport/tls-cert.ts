/**
 * Self-signed TLS certificate provisioning for IPPS (IPP over TLS).
 *
 * IPPS rides on HTTPS, which needs a server certificate. Rather than add a
 * crypto dependency, this module shells out to the system `openssl` binary
 * (array argv, never a shell) to mint a self-signed RSA cert the first time
 * it's needed, then caches the PEM files on disk and reuses them on subsequent
 * starts. The cert is self-signed (CN=printer-emulator) with localhost/127.0.0.1
 * SANs — fine for an emulator, but clients must skip verification (ipptool's
 * default, or `rejectUnauthorized:false`).
 *
 * Never throws: if openssl is missing or generation fails, it logs a warning
 * and returns null so the caller can run plaintext-only without TLS.
 */

import { spawnSync, execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Logger } from '../logging/logger.js';

/** Resolved paths to the cert/key PEM files. */
export interface SelfSignedCert {
  certPath: string;
  keyPath: string;
}

/** The exact openssl argv used to mint the self-signed cert (no shell). */
export function opensslArgv(keyPath: string, certPath: string): string[] {
  return [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '825',
    '-subj',
    '/CN=printer-emulator',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ];
}

let opensslResolved: string | null | undefined;

/**
 * Resolve the `openssl` binary from PATH once, caching the result. Returns the
 * binary name (`openssl`) when available, or null when no openssl is on PATH.
 */
function resolveOpenssl(): string | null {
  if (opensslResolved !== undefined) return opensslResolved;
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    opensslResolved = 'openssl';
  } catch {
    opensslResolved = null;
  }
  return opensslResolved;
}

/**
 * Ensure a self-signed cert exists under `dir`, generating one via openssl if
 * `<dir>/cert.pem` and `<dir>/key.pem` aren't both already present. Returns the
 * resolved paths, or null when openssl is unavailable or generation fails
 * (caller then skips TLS). Idempotent: an existing pair is reused untouched.
 */
export function ensureSelfSignedCert(
  dir: string,
  logger: Logger
): SelfSignedCert | null {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');

  if (existsSync(certPath) && existsSync(keyPath)) {
    logger.debug('Reusing existing self-signed TLS certificate', {
      certPath,
      keyPath,
    });
    return { certPath, keyPath };
  }

  const openssl = resolveOpenssl();
  if (!openssl) {
    logger.warn(
      'openssl not found on PATH — cannot generate TLS certificate; skipping IPPS'
    );
    return null;
  }

  try {
    mkdirSync(dir, { recursive: true });
    const result = spawnSync(openssl, opensslArgv(keyPath, certPath), {
      stdio: 'ignore',
    });
    if (result.error || result.status !== 0) {
      logger.warn('openssl failed to generate TLS certificate; skipping IPPS', {
        status: result.status ?? -1,
        error: result.error?.message ?? 'non-zero exit',
      });
      return null;
    }
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      logger.warn('openssl reported success but cert/key missing; skipping IPPS');
      return null;
    }
    logger.info('Generated self-signed TLS certificate', { certPath, keyPath });
    return { certPath, keyPath };
  } catch (err) {
    logger.warn('Failed to generate TLS certificate; skipping IPPS', {
      error: (err as Error).message,
    });
    return null;
  }
}
