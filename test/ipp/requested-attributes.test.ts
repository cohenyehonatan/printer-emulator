import { describe, it, expect } from 'vitest';
import {
  OperationIds,
  StatusCodes,
  PrinterStates,
  DelimiterTags,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
} from '../../src/ipp/constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  keywordAttr,
  findAttr,
  type IppAttribute,
} from '../../src/ipp/attribute.js';
import {
  operationGroup,
  getGroupAttributes,
  type IppRequest,
} from '../../src/ipp/message.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import { dispatch, type OperationContext } from '../../src/ipp/dispatcher.js';
import { JobQueue } from '../../src/printer/job-queue.js';
import {
  DEFAULT_IDENTITY,
  buildPrinterAttributes,
} from '../../src/printer/printer-attributes.js';

function makeContext(): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue: new JobQueue(),
    printerState: () => PrinterStates.IDLE,
  };
}

/** Build a Get-Printer-Attributes request with optional requested-attributes. */
function getPrinterAttributesRequest(requested?: string[]): IppRequest {
  const extra: IppAttribute[] = [];
  if (requested !== undefined) {
    extra.push(keywordAttr('requested-attributes', ...requested));
  }
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: OperationIds.GET_PRINTER_ATTRIBUTES,
    requestId: 11,
    groups: [
      operationGroup([
        charsetAttr('attributes-charset', DEFAULT_CHARSET),
        naturalLanguageAttr(
          'attributes-natural-language',
          DEFAULT_NATURAL_LANGUAGE
        ),
        ...extra,
      ]),
    ],
  };
}

function printerAttrsOf(response: { groups: { tag: number }[] }) {
  return getGroupAttributes(
    response as Parameters<typeof getGroupAttributes>[0],
    DelimiterTags.PRINTER_ATTRIBUTES
  );
}

const FULL_COUNT = buildPrinterAttributes(
  DEFAULT_IDENTITY,
  PrinterStates.IDLE
).length;

describe('requested-attributes sub-selection (Get-Printer-Attributes)', () => {
  it('returns ONLY the requested attributes', () => {
    const response = dispatch(
      decode(
        encode(
          getPrinterAttributesRequest(['printer-name', 'printer-state'])
        )
      ),
      makeContext()
    );
    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const attrs = printerAttrsOf(response);
    expect(attrs).toHaveLength(2);
    expect(findAttr(attrs, 'printer-name')).toBeDefined();
    expect(findAttr(attrs, 'printer-state')).toBeDefined();
    // Not requested → absent.
    expect(findAttr(attrs, 'printer-make-and-model')).toBeUndefined();
    expect(findAttr(attrs, 'document-format-supported')).toBeUndefined();
  });

  it('requested-attributes=[all] returns the full set', () => {
    const response = dispatch(
      decode(encode(getPrinterAttributesRequest(['all']))),
      makeContext()
    );
    const attrs = printerAttrsOf(response);
    expect(attrs).toHaveLength(FULL_COUNT);
    expect(findAttr(attrs, 'printer-name')).toBeDefined();
    expect(findAttr(attrs, 'document-format-supported')).toBeDefined();
  });

  it('ABSENT requested-attributes returns the full set (back-compat)', () => {
    const response = dispatch(
      decode(encode(getPrinterAttributesRequest(undefined))),
      makeContext()
    );
    const attrs = printerAttrsOf(response);
    expect(attrs).toHaveLength(FULL_COUNT);
    expect(findAttr(attrs, 'printer-name')).toBeDefined();
    expect(findAttr(attrs, 'printer-make-and-model')).toBeDefined();
  });

  it('an unknown requested name is simply omitted (no error)', () => {
    const response = dispatch(
      decode(
        encode(
          getPrinterAttributesRequest(['printer-name', 'no-such-attribute'])
        )
      ),
      makeContext()
    );
    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const attrs = printerAttrsOf(response);
    expect(attrs).toHaveLength(1);
    expect(findAttr(attrs, 'printer-name')).toBeDefined();
  });
});
