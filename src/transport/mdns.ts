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

/** Inputs for building the IPPS (`_ipps._tcp`, IPP-over-TLS) mDNS service. */
export interface IppsServiceParams {
  identity: PrinterIdentity;
  /** The TLS port the HTTPS/IPPS server listens on. */
  port: number;
  /** Hostname clients reach the printer's IPPS endpoint at. */
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
 * Build the AirPrint TXT record shared by the `_ipp._tcp` and `_ipps._tcp`
 * advertisements. Both describe the same printer/capabilities; the only
 * difference is the adminurl scheme (http vs https). `TLS=1.2` is advertised in
 * both because the printer always offers an IPPS endpoint when this is built.
 */
function buildAirPrintTxt(
  identity: PrinterIdentity,
  host: string,
  port: number,
  scheme: 'http' | 'https'
): Record<string, string> {
  return {
    txtvers: '1',
    qtotal: '1',
    rp: resourcePathFromUri(identity.uri),
    ty: identity.makeAndModel,
    note: identity.location,
    product: `(${identity.makeAndModel})`,
    pdl: SUPPORTED_FORMATS.join(','),
    URF: URF_SUPPORTED,
    adminurl: `${scheme}://${host}:${port}/`,
    UUID: identity.uuid,
    TLS: '1.2',
    Color: 'T',
    Duplex: 'T',
    Scan: 'F',
    priority: '50',
  };
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

  return {
    name: identity.name,
    type: 'ipp',
    protocol: 'tcp',
    port,
    host: `${host}.`,
    subtypes: [UNIVERSAL_SUBTYPE],
    txt: buildAirPrintTxt(identity, host, port, 'http'),
  };
}

/**
 * Build the bonjour ServiceConfig for an IPPS `_ipps._tcp` (IPP-over-TLS)
 * advertisement, the secure sibling of `buildAirPrintService`. Same printer,
 * same `rp=ipp/print` resource path, same capabilities — but on the TLS port,
 * with an `https://` adminurl. AirPrint prefers `_ipps._tcp` when both exist.
 * Pure + side-effect-free so it's unit-testable without opening a socket.
 */
export function buildIppsService(params: IppsServiceParams): ServiceConfig {
  const { identity, port } = params;
  const host = params.host ?? 'localhost';

  return {
    name: identity.name,
    type: 'ipps',
    protocol: 'tcp',
    port,
    host: `${host}.`,
    subtypes: [UNIVERSAL_SUBTYPE],
    txt: buildAirPrintTxt(identity, host, port, 'https'),
  };
}

export class MdnsAdvertiser {
  private readonly logger = new Logger('MDNS', 'info');
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;
  private ippsService: Service | null = null;
  private readonly config: ServiceConfig;
  /** IPPS (`_ipps._tcp`) config, present only when TLS is enabled. */
  private readonly ippsConfig: ServiceConfig | null;

  constructor(params: AirPrintServiceParams & { ipps?: IppsServiceParams }) {
    this.config = buildAirPrintService(params);
    this.ippsConfig = params.ipps ? buildIppsService(params.ipps) : null;
  }

  /**
   * Publish the AirPrint `_ipp._tcp` service on the network — plus the secure
   * `_ipps._tcp` service when TLS is enabled (both share one bonjour instance).
   */
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

    if (this.ippsConfig) {
      this.ippsService = this.bonjour.publish(this.ippsConfig);
      this.logger.info('mDNS advertising AirPrint IPPS service', {
        service: '_ipps._tcp',
        subtype: `_${UNIVERSAL_SUBTYPE}._sub._ipps._tcp`,
        instance: this.ippsConfig.name,
        port: this.ippsConfig.port,
        rp: this.ippsConfig.txt?.rp,
      });
    }
  }

  /**
   * Unpublish every service and destroy the bonjour instance. Closes the
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
    this.ippsService = null;
    this.logger.info('mDNS advertising stopped');
  }

  isAdvertising(): boolean {
    return this.bonjour !== null;
  }

  /** The resolved `_ipp._tcp` service config (for inspection/tests). */
  getConfig(): ServiceConfig {
    return this.config;
  }

  /** The resolved `_ipps._tcp` service config, or null when TLS is off. */
  getIppsConfig(): ServiceConfig | null {
    return this.ippsConfig;
  }
}
