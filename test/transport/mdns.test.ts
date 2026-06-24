import { describe, it, expect } from 'vitest';
import {
  buildAirPrintService,
  resourcePathFromUri,
  UNIVERSAL_SUBTYPE,
} from '../../src/transport/mdns.js';
import {
  DEFAULT_IDENTITY,
  SUPPORTED_FORMATS,
  URF_SUPPORTED,
} from '../../src/printer/printer-attributes.js';

/**
 * These tests exercise the PURE TXT/service-config builder only — they never
 * publish on the network, so no multicast socket is ever opened.
 */
describe('AirPrint mDNS service construction', () => {
  it('derives the rp resource path from the printer URI path', () => {
    expect(resourcePathFromUri('ipp://host:631/ipp/print')).toBe('ipp/print');
    expect(resourcePathFromUri('ipp://host:631/')).toBe('ipp/print');
    expect(resourcePathFromUri('not a uri')).toBe('ipp/print');
  });

  it('builds an _ipp._tcp service with the universal subtype', () => {
    const svc = buildAirPrintService({
      identity: DEFAULT_IDENTITY,
      port: 6310,
      host: 'printer.local',
    });

    expect(svc.type).toBe('ipp');
    expect(svc.protocol).toBe('tcp');
    expect(svc.port).toBe(6310);
    expect(svc.name).toBe(DEFAULT_IDENTITY.name);
    expect(svc.subtypes).toContain(UNIVERSAL_SUBTYPE);
  });

  it('constructs the AirPrint TXT record from printer attributes', () => {
    const svc = buildAirPrintService({
      identity: DEFAULT_IDENTITY,
      port: 6310,
      host: 'printer.local',
    });
    const txt = svc.txt as Record<string, string>;

    expect(txt.rp).toBe('ipp/print');
    expect(txt.ty).toBe(DEFAULT_IDENTITY.makeAndModel);
    expect(txt.note).toBe(DEFAULT_IDENTITY.location);
    expect(txt.product).toBe(`(${DEFAULT_IDENTITY.makeAndModel})`);
    expect(txt.pdl).toBe(SUPPORTED_FORMATS.join(','));
    expect(txt.pdl).toContain('application/pdf');
    expect(txt.URF).toBe(URF_SUPPORTED);
    expect(txt.adminurl).toBe('http://printer.local:6310/');
    expect(txt.UUID).toBe(DEFAULT_IDENTITY.uuid);
    expect(txt.txtvers).toBe('1');
    expect(txt.qtotal).toBe('1');
  });

  it('defaults the host to localhost when none is given', () => {
    const svc = buildAirPrintService({
      identity: DEFAULT_IDENTITY,
      port: 631,
    });
    const txt = svc.txt as Record<string, string>;
    expect(txt.adminurl).toBe('http://localhost:631/');
  });
});
