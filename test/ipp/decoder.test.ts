import { describe, it, expect } from 'vitest';
import { decode } from '../../src/ipp/decoder.js';
import { BufferWriter } from '../../src/utils/buffer-writer.js';
import {
  DelimiterTags,
  ValueTags,
  OperationIds,
} from '../../src/ipp/constants.js';
import { getGroupAttributes, getGroup } from '../../src/ipp/message.js';
import { findAttr } from '../../src/ipp/attribute.js';

/**
 * Hand-build a Get-Printer-Attributes request buffer byte-by-byte and assert
 * the decoder extracts the header and attributes correctly.
 */
function buildGetPrinterAttributesRequest(): Buffer {
  const w = new BufferWriter();
  // Header: version 2.0, op = Get-Printer-Attributes, request-id 1
  w.writeUInt8(0x02).writeUInt8(0x00);
  w.writeUInt16BE(OperationIds.GET_PRINTER_ATTRIBUTES);
  w.writeInt32BE(1);

  // operation-attributes group
  w.writeUInt8(DelimiterTags.OPERATION_ATTRIBUTES);

  // attributes-charset (charset) = "utf-8"
  writeStringAttr(w, ValueTags.CHARSET, 'attributes-charset', 'utf-8');
  // attributes-natural-language (naturalLanguage) = "en"
  writeStringAttr(
    w,
    ValueTags.NATURAL_LANGUAGE,
    'attributes-natural-language',
    'en'
  );
  // printer-uri (uri)
  writeStringAttr(
    w,
    ValueTags.URI,
    'printer-uri',
    'ipp://localhost:631/ipp/print'
  );

  w.writeUInt8(DelimiterTags.END_OF_ATTRIBUTES);
  return w.toBuffer();
}

function writeStringAttr(
  w: BufferWriter,
  tag: number,
  name: string,
  value: string
): void {
  w.writeUInt8(tag);
  w.writeUInt16BE(name.length);
  w.writeString(name);
  w.writeUInt16BE(value.length);
  w.writeString(value);
}

describe('IPP decoder', () => {
  it('decodes a hand-built Get-Printer-Attributes request', () => {
    const buf = buildGetPrinterAttributesRequest();
    const msg = decode(buf);

    expect(msg.versionMajor).toBe(2);
    expect(msg.versionMinor).toBe(0);
    expect(msg.operationIdOrStatusCode).toBe(
      OperationIds.GET_PRINTER_ATTRIBUTES
    );
    expect(msg.requestId).toBe(1);

    const opGroup = getGroup(msg, DelimiterTags.OPERATION_ATTRIBUTES);
    expect(opGroup).toBeDefined();

    const opAttrs = getGroupAttributes(
      msg,
      DelimiterTags.OPERATION_ATTRIBUTES
    );
    expect(findAttr(opAttrs, 'attributes-charset')?.values[0]?.value).toBe(
      'utf-8'
    );
    expect(
      findAttr(opAttrs, 'attributes-natural-language')?.values[0]?.value
    ).toBe('en');
    expect(findAttr(opAttrs, 'printer-uri')?.values[0]?.value).toBe(
      'ipp://localhost:631/ipp/print'
    );

    // No trailing document data on this request.
    expect(msg.data).toBeUndefined();
  });
});
