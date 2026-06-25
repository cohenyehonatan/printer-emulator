/**
 * marker-* supply attributes (ink/toner gauge) — RFC 8011 §5.4.30–§5.4.36 /
 * PWG 5100.12. Asserts the parallel-array invariant, value ranges/sentinels,
 * the correct value-tags on the wire, and requested-attributes filtering.
 */

import { describe, it, expect } from 'vitest';
import {
  OperationIds,
  StatusCodes,
  PrinterStates,
  DelimiterTags,
  ValueTags,
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
import {
  buildMarkerAttributes,
  DEFAULT_CMYK_MARKERS,
} from '../../src/printer/printer-supplies.js';

const MARKER_LIST_ATTRS = [
  'marker-names',
  'marker-types',
  'marker-colors',
  'marker-levels',
  'marker-low-levels',
  'marker-high-levels',
  'marker-units',
];

function makeContext(): OperationContext {
  return {
    identity: DEFAULT_IDENTITY,
    queue: new JobQueue(),
    printerState: () => PrinterStates.IDLE,
  };
}

function getPrinterAttributesRequest(requested?: string[]): IppRequest {
  const extra: IppAttribute[] = [];
  if (requested !== undefined) {
    extra.push(keywordAttr('requested-attributes', ...requested));
  }
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: OperationIds.GET_PRINTER_ATTRIBUTES,
    requestId: 21,
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

describe('buildMarkerAttributes (supply model)', () => {
  const attrs = buildMarkerAttributes();
  const len = DEFAULT_CMYK_MARKERS.length;

  it('models a 4-supply CMYK ink set (printer advertises color)', () => {
    expect(len).toBe(4);
    const names = findAttr(attrs, 'marker-names')!;
    expect(names.values.map((v) => v.value)).toEqual([
      'Cyan Ink',
      'Magenta Ink',
      'Yellow Ink',
      'Black Ink',
    ]);
  });

  it('all marker-* list attributes are PARALLEL (equal length)', () => {
    for (const name of MARKER_LIST_ATTRS) {
      const a = findAttr(attrs, name);
      expect(a, `${name} present`).toBeDefined();
      expect(a!.values, `${name} length`).toHaveLength(len);
    }
  });

  it('marker-levels are in 0–100 (or -1/-2 sentinel) per RFC 8011 §5.4.32', () => {
    const levels = findAttr(attrs, 'marker-levels')!.values.map(
      (v) => v.value as number
    );
    for (const lvl of levels) {
      const inRange = lvl >= 0 && lvl <= 100;
      const sentinel = lvl === -1 || lvl === -2;
      expect(inRange || sentinel).toBe(true);
    }
  });

  it('marker-low/high-levels are 10 and 100', () => {
    const low = findAttr(attrs, 'marker-low-levels')!.values.map(
      (v) => v.value
    );
    const high = findAttr(attrs, 'marker-high-levels')!.values.map(
      (v) => v.value
    );
    expect(low).toEqual([10, 10, 10, 10]);
    expect(high).toEqual([100, 100, 100, 100]);
  });

  it('emits the correct IPP value-tags', () => {
    const tagOf = (name: string) => findAttr(attrs, name)!.values[0]!.tag;
    expect(tagOf('marker-names')).toBe(ValueTags.NAME_WITHOUT_LANG);
    expect(tagOf('marker-colors')).toBe(ValueTags.NAME_WITHOUT_LANG);
    expect(tagOf('marker-types')).toBe(ValueTags.KEYWORD);
    expect(tagOf('marker-levels')).toBe(ValueTags.INTEGER);
    expect(tagOf('marker-low-levels')).toBe(ValueTags.INTEGER);
    expect(tagOf('marker-high-levels')).toBe(ValueTags.INTEGER);
    expect(tagOf('marker-units')).toBe(ValueTags.INTEGER);
    expect(findAttr(attrs, 'marker-message')!.values[0]!.tag).toBe(
      ValueTags.TEXT_WITHOUT_LANG
    );
  });

  it('marker-colors are #RRGGBB sRGB hex', () => {
    const colors = findAttr(attrs, 'marker-colors')!.values.map(
      (v) => v.value
    );
    expect(colors).toEqual(['#00FFFF', '#FF00FF', '#FFFF00', '#000000']);
  });
});

describe('marker-* on the Get-Printer-Attributes wire', () => {
  it('round-trips through encode/decode/dispatch with the full set', () => {
    const response = dispatch(
      decode(encode(getPrinterAttributesRequest(['all']))),
      makeContext()
    );
    expect(response.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const attrs = printerAttrsOf(response);

    const len = DEFAULT_CMYK_MARKERS.length;
    for (const name of MARKER_LIST_ATTRS) {
      const a = findAttr(attrs, name);
      expect(a, `${name} present`).toBeDefined();
      expect(a!.values, `${name} length`).toHaveLength(len);
    }
    const levels = findAttr(attrs, 'marker-levels')!.values.map(
      (v) => v.value as number
    );
    expect(levels).toEqual([60, 45, 90, 80]);
    expect(findAttr(attrs, 'marker-message')).toBeDefined();
  });

  it('includes marker-* under requested-attributes=[printer-description]', () => {
    const response = dispatch(
      decode(encode(getPrinterAttributesRequest(['printer-description']))),
      makeContext()
    );
    const attrs = printerAttrsOf(response);
    expect(findAttr(attrs, 'marker-levels')).toBeDefined();
    expect(findAttr(attrs, 'marker-names')).toBeDefined();
  });

  it('returns ONLY marker-levels when that is the only requested attribute', () => {
    const response = dispatch(
      decode(encode(getPrinterAttributesRequest(['marker-levels']))),
      makeContext()
    );
    const attrs = printerAttrsOf(response);
    expect(attrs).toHaveLength(1);
    expect(findAttr(attrs, 'marker-levels')).toBeDefined();
    expect(findAttr(attrs, 'marker-names')).toBeUndefined();
    expect(findAttr(attrs, 'printer-name')).toBeUndefined();
  });

  it('omits marker-* when not requested', () => {
    const response = dispatch(
      decode(encode(getPrinterAttributesRequest(['printer-name']))),
      makeContext()
    );
    const attrs = printerAttrsOf(response);
    expect(findAttr(attrs, 'marker-levels')).toBeUndefined();
    expect(findAttr(attrs, 'marker-names')).toBeUndefined();
  });
});

describe('buildPrinterAttributes includes the supply gauge by default', () => {
  it('emits marker-levels in the default attribute set', () => {
    const attrs = buildPrinterAttributes(DEFAULT_IDENTITY, PrinterStates.IDLE);
    expect(findAttr(attrs, 'marker-levels')).toBeDefined();
    expect(findAttr(attrs, 'marker-names')).toBeDefined();
  });
});
