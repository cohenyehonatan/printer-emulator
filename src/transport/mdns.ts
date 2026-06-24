/**
 * AirPrint / Bonjour service advertiser — STUB.
 *
 * AirPrint discovers printers via mDNS/DNS-SD: a printer advertises an
 * `_ipp._tcp` (and `_universal._sub._ipp._tcp` for AirPrint) service with a
 * TXT record describing its capabilities (rp=ipp/print, pdl=..., URF=...).
 * Implementing real multicast DNS needs a socket-level mDNS responder, which
 * is intentionally out of scope here to avoid a third-party dependency.
 *
 * This stub records the advertisement parameters and logs them; it never binds
 * a socket and never throws.
 */

import { Logger } from '../logging/logger.js';

export interface MdnsServiceInfo {
  serviceType: string; // e.g. _ipp._tcp
  instanceName: string;
  port: number;
  txt: Record<string, string>;
}

export class MdnsAdvertiser {
  private readonly logger = new Logger('MDNS', 'info');
  private advertising = false;

  constructor(private readonly info: MdnsServiceInfo) {}

  /** Pretend to start advertising the service. */
  start(): void {
    // TODO: bind UDP 5353 and respond to _ipp._tcp PTR/SRV/TXT queries.
    this.advertising = true;
    this.logger.info('mDNS advertise (stub)', {
      service: this.info.serviceType,
      instance: this.info.instanceName,
      port: this.info.port,
    });
  }

  /** Stop advertising. */
  stop(): void {
    // TODO: send goodbye packets and close the socket.
    this.advertising = false;
  }

  isAdvertising(): boolean {
    return this.advertising;
  }
}

/** Build a default AirPrint-style advertisement for a printer. */
export function buildAirPrintService(
  instanceName: string,
  port: number
): MdnsServiceInfo {
  return {
    serviceType: '_ipp._tcp',
    instanceName,
    port,
    txt: {
      rp: 'ipp/print',
      ty: instanceName,
      pdl: 'application/pdf,image/urf,image/pwg-raster',
      URF: 'V1.4,CP1,PQ4',
      txtvers: '1',
      qtotal: '1',
    },
  };
}
