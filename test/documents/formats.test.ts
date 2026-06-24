import { describe, it, expect } from 'vitest';
import { detectFormat, Mime } from '../../src/documents/formats.js';

describe('detectFormat', () => {
  it('detects PDF from %PDF', () => {
    expect(detectFormat(Buffer.from('%PDF-1.7\n...', 'ascii'))).toBe(Mime.PDF);
  });

  it('detects PostScript from %!', () => {
    expect(detectFormat(Buffer.from('%!PS-Adobe-3.0\n', 'ascii'))).toBe(
      Mime.POSTSCRIPT
    );
  });

  it('detects PWG Raster from RaS2 sync word', () => {
    expect(detectFormat(Buffer.from('RaS2\x00\x00', 'binary'))).toBe(
      Mime.PWG_RASTER
    );
  });

  it('detects Apple URF from UNIRAST', () => {
    expect(detectFormat(Buffer.from('UNIRAST\x00', 'binary'))).toBe(Mime.URF);
  });

  it('detects PCL from ESC E', () => {
    expect(detectFormat(Buffer.from([0x1b, 0x45, 0x20]))).toBe(Mime.PCL);
  });

  it('falls back to octet-stream for unknown/empty input', () => {
    expect(detectFormat(Buffer.from('zzz', 'ascii'))).toBe(Mime.OCTET_STREAM);
    expect(detectFormat(Buffer.alloc(0))).toBe(Mime.OCTET_STREAM);
  });
});
