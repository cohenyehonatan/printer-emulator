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

  it('TWO separate requested-attributes attributes are coalesced (union)', () => {
    // Non-canonical wire shape: instead of one 1setOf keyword, the client sends
    // two separate `requested-attributes` attributes (one keyword each). We
    // must honor BOTH, not just the first.
    const req: IppRequest = {
      versionMajor: IPP_VERSION_MAJOR,
      versionMinor: IPP_VERSION_MINOR,
      operationIdOrStatusCode: OperationIds.GET_PRINTER_ATTRIBUTES,
      requestId: 12,
      groups: [
        operationGroup([
          charsetAttr('attributes-charset', DEFAULT_CHARSET),
          naturalLanguageAttr(
            'attributes-natural-language',
            DEFAULT_NATURAL_LANGUAGE
          ),
          keywordAttr('requested-attributes', 'printer-name'),
          keywordAttr('requested-attributes', 'printer-state'),
        ]),
      ],
    };
    const response = dispatch(decode(encode(req)), makeContext());
    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const attrs = printerAttrsOf(response);
    // BOTH names returned — the union, not just the first attribute.
    expect(attrs).toHaveLength(2);
    expect(findAttr(attrs, 'printer-name')).toBeDefined();
    expect(findAttr(attrs, 'printer-state')).toBeDefined();
    expect(findAttr(attrs, 'printer-make-and-model')).toBeUndefined();
  });

  it('the canonical single-1setOf path still returns ALL requested names', () => {
    // Regression guard: a single attribute carrying multiple keyword values
    // must keep resolving to every value (unchanged behavior).
    const response = dispatch(
      decode(
        encode(
          getPrinterAttributesRequest([
            'printer-name',
            'printer-state',
            'printer-make-and-model',
          ])
        )
      ),
      makeContext()
    );
    const attrs = printerAttrsOf(response);
    expect(attrs).toHaveLength(3);
    expect(findAttr(attrs, 'printer-name')).toBeDefined();
    expect(findAttr(attrs, 'printer-state')).toBeDefined();
    expect(findAttr(attrs, 'printer-make-and-model')).toBeDefined();
  });

  it('a group keyword in a SECOND requested-attributes attr still expands to all', () => {
    // Coalescing must not break group-keyword expansion: a duplicate attr whose
    // value is `all` still yields the whole set (union includes the group kw).
    const req: IppRequest = {
      versionMajor: IPP_VERSION_MAJOR,
      versionMinor: IPP_VERSION_MINOR,
      operationIdOrStatusCode: OperationIds.GET_PRINTER_ATTRIBUTES,
      requestId: 13,
      groups: [
        operationGroup([
          charsetAttr('attributes-charset', DEFAULT_CHARSET),
          naturalLanguageAttr(
            'attributes-natural-language',
            DEFAULT_NATURAL_LANGUAGE
          ),
          keywordAttr('requested-attributes', 'printer-name'),
          keywordAttr('requested-attributes', 'all'),
        ]),
      ],
    };
    const response = dispatch(decode(encode(req)), makeContext());
    const attrs = printerAttrsOf(response);
    expect(attrs).toHaveLength(FULL_COUNT);
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
