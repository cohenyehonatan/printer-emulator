/**
 * AirPrint discovery scenario.
 *
 * Performs a Get-Printer-Attributes round trip — the request an AirPrint/CUPS
 * client makes after mDNS discovery to learn a printer's identity and
 * capabilities. Asserts successful-ok and that a printer-attributes group with
 * printer-name comes back.
 */

import {
  StatusCodes,
  DelimiterTags,
} from '../../ipp/constants.js';
import { getGroupAttributes } from '../../ipp/message.js';
import { findAttr } from '../../ipp/attribute.js';
import type { Scenario } from './scenario.js';

export const airprintDiscoveryScenario: Scenario = {
  name: 'AirPrint Discovery',
  description: 'Get-Printer-Attributes round trip after discovery',
  steps: [
    {
      name: 'Get-Printer-Attributes returns successful-ok with printer-name',
      run: async (client) => {
        const res = await client.getPrinterAttributes();
        if (res.operationIdOrStatusCode !== StatusCodes.SUCCESSFUL_OK) {
          throw new Error(
            `expected successful-ok, got 0x${res.operationIdOrStatusCode.toString(16)}`
          );
        }
        const printerAttrs = getGroupAttributes(
          res,
          DelimiterTags.PRINTER_ATTRIBUTES
        );
        if (!findAttr(printerAttrs, 'printer-name')) {
          throw new Error('response missing printer-name');
        }
      },
    },
  ],
};
