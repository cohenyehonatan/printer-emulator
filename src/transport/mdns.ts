/**
 * AirPrint / Bonjour service advertiser — real mDNS/DNS-SD via bonjour-service.
 *
 * AirPrint discovers printers over multicast DNS: a printer advertises an
 * `_ipp._tcp` service (plus the `_universal._sub._ipp._tcp` subtype AirPrint
 * clients filter on) carrying a TXT record that describes its capabilities
 * (rp=ipp/print, pdl=..., URF=...). This module builds that service config from
 * the printer's own attributes and publishes it on the network.
 *
 * The TXT/service construction is factored into the pure `buildAirPrintService`
 * function so it can be unit-tested without opening a socket. `MdnsAdvertiser`
 * owns the bonjour instance and is the only thing that touches the network;
 * stop() unpublishes and destroys the instance so the process can exit cleanly.
 */

import { Bonjour, type Service, type ServiceConfig } from 'bonjour-service';
import { Logger } from '../logging/logger.js';
import {
  type PrinterIdentity,
  SUPPORTED_FORMATS,
  URF_SUPPORTED,
} from '../printer/printer-attributes.js';

/** AirPrint subtype AirPrint clients filter `_ipp._tcp` discovery on. */
export const UNIVERSAL_SUBTYPE = 'universal';

/** Inputs for building the AirPrint mDNS service config. */
export interface AirPrintServiceParams {
  identity: PrinterIdentity;
  port: number;
  /** Hostname clients reach the printer's HTTP/IPP endpoint at. */
  host?: string;
}

/**
 * Derive the IPP resource path (the mDNS `rp` TXT key) from the printer URI's
 * path, stripping the leading slash so it matches the HTTP server's IPP route
 * (e.g. `ipp://host:port/ipp/print` -> `ipp/print`). Falls back to `ipp/print`.
 */
export function resourcePathFromUri(uri: string): string {
  try {
    const path = new URL(uri).pathname.replace(/^\/+/, '');
    return path.length > 0 ? path : 'ipp/print';
  } catch {
    return 'ipp/print';
  }
}

/**
 * Build the bonjour ServiceConfig for an AirPrint `_ipp._tcp` advertisement.
 *
 * Pure + side-effect-free: constructs the TXT record from the printer's own
 * attributes (rp, ty, note, product, pdl, URF, adminurl, UUID, ...) so the
 * advertised capabilities stay consistent with Get-Printer-Attributes. Tests
 * exercise this without publishing on the network.
 */
export function buildAirPrintService(
  params: AirPrintServiceParams
): ServiceConfig {
  const { identity, port } = params;
  const host = params.host ?? 'localhost';
  const rp = resourcePathFromUri(identity.uri);

  const txt: Record<string, string> = {
    txtvers: '1',
    qtotal: '1',
    rp,
    ty: identity.makeAndModel,
    note: identity.location,
    product: `(${identity.makeAndModel})`,
    pdl: SUPPORTED_FORMATS.join(','),
    URF: URF_SUPPORTED,
    adminurl: `http://${host}:${port}/`,
    UUID: identity.uuid,
    TLS: '1.2',
    Color: 'T',
    Duplex: 'T',
    Scan: 'F',
    priority: '50',
  };

  return {
    name: identity.name,
    type: 'ipp',
    protocol: 'tcp',
    port,
    host: `${host}.`,
    subtypes: [UNIVERSAL_SUBTYPE],
    txt,
  };
}

export class MdnsAdvertiser {
  private readonly logger = new Logger('MDNS', 'info');
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;
  private readonly config: ServiceConfig;

  constructor(params: AirPrintServiceParams) {
    this.config = buildAirPrintService(params);
  }

  /** Publish the AirPrint `_ipp._tcp` service on the network. */
  start(): void {
    if (this.bonjour) return;
    this.bonjour = new Bonjour();
    this.service = this.bonjour.publish(this.config);
    this.logger.info('mDNS advertising AirPrint service', {
      service: '_ipp._tcp',
      subtype: `_${UNIVERSAL_SUBTYPE}._sub._ipp._tcp`,
      instance: this.config.name,
      port: this.config.port,
      rp: this.config.txt?.rp,
    });
  }

  /**
   * Unpublish the service and destroy the bonjour instance. Closes the
   * underlying multicast socket so a host process can exit cleanly.
   */
  async stop(): Promise<void> {
    if (!this.bonjour) return;
    const bonjour = this.bonjour;
    await new Promise<void>((resolve) => {
      bonjour.unpublishAll(() => bonjour.destroy(() => resolve()));
    });
    this.bonjour = null;
    this.service = null;
    this.logger.info('mDNS advertising stopped');
  }

  isAdvertising(): boolean {
    return this.bonjour !== null;
  }

  /** The resolved service config (for inspection/tests). */
  getConfig(): ServiceConfig {
    return this.config;
  }
}
