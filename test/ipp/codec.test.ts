import { describe, it, expect } from 'vitest';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import {
  OperationIds,
  StatusCodes,
  ValueTags,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
} from '../../src/ipp/constants.js';
import {
  operationGroup,
  printerGroup,
  type IppRequest,
} from '../../src/ipp/message.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  uriAttr,
  integerAttr,
  enumAttr,
  booleanAttr,
  keywordAttr,
  rangesAttr,
  allRanges,
} from '../../src/ipp/attribute.js';

/**
 * The key proof: a non-trivial IppRequest must survive encode -> decode with
 * its header and every attribute (including a multi-value 1setOf) intact.
 */
describe('IPP codec round-trip', () => {
  it('round-trips header + multiple attribute groups', () => {
    const request: IppRequest = {
      versionMajor: IPP_VERSION_MAJOR,
      versionMinor: IPP_VERSION_MINOR,
      operationIdOrStatusCode: OperationIds.GET_PRINTER_ATTRIBUTES,
      requestId: 0x12345678,
      groups: [
        operationGroup([
          charsetAttr('attributes-charset', 'utf-8'),
          naturalLanguageAttr('attributes-natural-language', 'en'),
          uriAttr('printer-uri', 'ipp://localhost:631/ipp/print'),
        ]),
        printerGroup([
          integerAttr('copies', 3),
          enumAttr('printer-state', 3),
          booleanAttr('printer-is-accepting-jobs', true),
          // 1setOf keyword — exercises the name-length=0 additional-value path.
          keywordAttr('media-supported', 'iso_a4_210x297mm', 'na_letter_8.5x11in'),
        ]),
      ],
    };

    const encoded = encode(request);
    const decoded = decode(encoded);

    // Header.
    expect(decoded.versionMajor).toBe(request.versionMajor);
    expect(decoded.versionMinor).toBe(request.versionMinor);
    expect(decoded.operationIdOrStatusCode).toBe(
      request.operationIdOrStatusCode
    );
    expect(decoded.requestId).toBe(request.requestId);

    // Group/attribute structure preserved exactly.
    expect(decoded.groups).toHaveLength(2);
    expect(decoded.groups[0].tag).toBe(request.groups[0].tag);
    expect(decoded.groups[1].tag).toBe(request.groups[1].tag);

    expect(decoded.groups[0].attributes).toEqual(request.groups[0].attributes);
    expect(decoded.groups[1].attributes).toEqual(request.groups[1].attributes);

    // The multi-value attribute kept both values.
    const media = decoded.groups[1].attributes.find(
      (a) => a.name === 'media-supported'
    );
    expect(media?.values).toHaveLength(2);
    expect(media?.values[0].tag).toBe(ValueTags.KEYWORD);
    expect(media?.values[1].value).toBe('na_letter_8.5x11in');
  });

  it('round-trips a 1setOf rangeOfInteger (page-ranges) attribute', () => {
    // page-ranges = 2-3, 7-7 — two rangeOfInteger values (value-tag 0x33).
    const request: IppRequest = {
      versionMajor: IPP_VERSION_MAJOR,
      versionMinor: IPP_VERSION_MINOR,
      operationIdOrStatusCode: OperationIds.PRINT_JOB,
      requestId: 42,
      groups: [
        operationGroup([charsetAttr('attributes-charset', 'utf-8')]),
        printerGroup([rangesAttr('page-ranges', [2, 3], [7, 7])]),
      ],
    };

    const decoded = decode(encode(request));
    const pageRanges = decoded.groups[1].attributes.find(
      (a) => a.name === 'page-ranges'
    );
    expect(pageRanges?.values).toHaveLength(2);
    expect(pageRanges?.values[0].tag).toBe(ValueTags.RANGE_OF_INTEGER);
    // Each value decodes back to its [lower, upper] tuple.
    expect(allRanges(pageRanges)).toEqual([
      [2, 3],
      [7, 7],
    ]);
  });

  it('round-trips a response with trailing document data', () => {
    const data = Buffer.from('%PDF-1.4 fake document bytes', 'ascii');
    const response = {
      versionMajor: IPP_VERSION_MAJOR,
      versionMinor: IPP_VERSION_MINOR,
      operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
      requestId: 9,
      groups: [
        operationGroup([charsetAttr('attributes-charset', 'utf-8')]),
      ],
      data,
    };

    const decoded = decode(encode(response));
    expect(decoded.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(decoded.requestId).toBe(9);
    expect(decoded.data?.equals(data)).toBe(true);
  });
});
