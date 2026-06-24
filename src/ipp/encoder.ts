/**
 * IPP binary encoder: IppMessage -> Buffer (RFC 8010 §3).
 *
 * Mirrors decoder.ts. Emits the 8-byte header, then each attribute group
 * (delimiter-tag followed by its attributes), then the end-of-attributes tag,
 * then optional document data. For a 1setOf attribute (multiple values) the
 * first value carries the name and every subsequent value uses name-length=0.
 */

import { BufferWriter } from '../utils/buffer-writer.js';
import { DelimiterTags, ValueTags, type ValueTag } from './constants.js';
import type { IppMessage } from './message.js';
import type { IppValue } from './attribute.js';

/** Encode a complete IPP message to a Buffer. */
export function encode(msg: IppMessage): Buffer {
  const w = new BufferWriter();

  w.writeUInt8(msg.versionMajor);
  w.writeUInt8(msg.versionMinor);
  w.writeUInt16BE(msg.operationIdOrStatusCode);
  w.writeInt32BE(msg.requestId);

  for (const group of msg.groups) {
    w.writeUInt8(group.tag);
    for (const attr of group.attributes) {
      attr.values.forEach((value, idx) => {
        // First value carries the name; additional 1setOf values use name-length 0.
        writeAttributeValue(w, idx === 0 ? attr.name : '', value);
      });
    }
  }

  w.writeUInt8(DelimiterTags.END_OF_ATTRIBUTES);

  if (msg.data && msg.data.length > 0) {
    w.writeBytes(msg.data);
  }

  return w.toBuffer();
}

function writeAttributeValue(
  w: BufferWriter,
  name: string,
  value: IppValue
): void {
  w.writeUInt8(value.tag);

  const nameBytes = Buffer.from(name, 'utf-8');
  w.writeUInt16BE(nameBytes.length);
  if (nameBytes.length > 0) w.writeBytes(nameBytes);

  const valueBytes = encodeValue(value.tag, value.value);
  w.writeUInt16BE(valueBytes.length);
  if (valueBytes.length > 0) w.writeBytes(valueBytes);
}

/** Encode a typed JS value into its raw value buffer based on the tag. */
function encodeValue(
  tag: ValueTag,
  value: number | boolean | string | Buffer | [number, number]
): Buffer {
  switch (tag) {
    case ValueTags.INTEGER:
    case ValueTags.ENUM: {
      const b = Buffer.allocUnsafe(4);
      b.writeInt32BE(Number(value) | 0, 0);
      return b;
    }
    case ValueTags.BOOLEAN: {
      const b = Buffer.allocUnsafe(1);
      b.writeUInt8(value ? 1 : 0, 0);
      return b;
    }
    case ValueTags.RANGE_OF_INTEGER: {
      // Two 4-byte big-endian integers: lower then upper bound. Defends against
      // a non-tuple value (treated as [0, 0]) so encoding never throws.
      const [lower, upper] = Array.isArray(value) ? value : [0, 0];
      const b = Buffer.allocUnsafe(8);
      b.writeInt32BE(Number(lower) | 0, 0);
      b.writeInt32BE(Number(upper) | 0, 4);
      return b;
    }
    case ValueTags.NO_VALUE:
    case ValueTags.UNSUPPORTED:
      return Buffer.alloc(0);
    default:
      // string families + opaque octetString-style values
      if (Buffer.isBuffer(value)) return value;
      return Buffer.from(String(value), 'utf-8');
  }
}
