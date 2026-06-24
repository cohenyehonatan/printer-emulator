import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureSelfSignedCert,
  opensslArgv,
} from '../../src/transport/tls-cert.js';
import { Logger } from '../../src/logging/logger.js';

/** Whether the system openssl binary is available — guards the live tests. */
function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const OPENSSL = hasOpenssl();
// Quiet logger so test output stays clean.
const logger = new Logger('TEST', 'error');

describe('ensureSelfSignedCert', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'printer-emu-cert-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('builds the documented openssl argv (no shell)', () => {
    const argv = opensslArgv('/k.pem', '/c.pem');
    expect(argv).toEqual([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      '/k.pem',
      '-out',
      '/c.pem',
      '-days',
      '825',
      '-subj',
      '/CN=printer-emulator',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]);
  });

  it.skipIf(!OPENSSL)(
    'generates a PEM cert+key and is idempotent on reuse',
    () => {
      const dir = tempDir();
      const result = ensureSelfSignedCert(dir, logger);
      expect(result).not.toBeNull();
      const { certPath, keyPath } = result!;

      expect(existsSync(certPath)).toBe(true);
      expect(existsSync(keyPath)).toBe(true);

      const cert = readFileSync(certPath, 'utf8');
      const key = readFileSync(keyPath, 'utf8');
      expect(cert).toContain('-----BEGIN CERTIFICATE-----');
      expect(cert).toContain('-----END CERTIFICATE-----');
      expect(key).toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);

      // Idempotence: a second call reuses the same files untouched.
      const mtimeBefore = statSync(certPath).mtimeMs;
      const second = ensureSelfSignedCert(dir, logger);
      expect(second).not.toBeNull();
      expect(second!.certPath).toBe(certPath);
      expect(second!.keyPath).toBe(keyPath);
      expect(statSync(certPath).mtimeMs).toBe(mtimeBefore);
    }
  );

  it.skipIf(OPENSSL)('returns null without throwing when openssl is absent', () => {
    const dir = tempDir();
    expect(() => ensureSelfSignedCert(dir, logger)).not.toThrow();
    expect(ensureSelfSignedCert(dir, logger)).toBeNull();
  });
});
