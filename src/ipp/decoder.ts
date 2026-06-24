/**
 * IPP binary decoder: Buffer -> IppMessage (RFC 8010 §3).
 *
 * Wire layout:
 *   version-major(1) version-minor(1)
 *   operation-id|status-code(2)  request-id(4)
 *   [ delimiter-tag(1) { value-tag(1) name-length(2) name value-length(2) value }* ]*
 *   end-of-attributes-tag(0x03)
 *   [ document-data ]
 *
 * Within a group, an attribute with name-length=0 is an additional value of
 * the immediately-preceding attribute (a 1setOf member), so it is appended to
 * that attribute rather than starting a new one.
 */

import { BufferReader } from '../utils/buffer-reader.js';
import {
  DelimiterTags,
  ValueTags,
  type DelimiterTag,
  type ValueTag,
} from './constants.js';
import type { IppMessage, IppAttributeGroup } from './message.js';
import type { IppAttribute, IppValue } from './attribute.js';

const DELIMITER_TAG_VALUES: number[] = Object.values(DelimiterTags);

function isDelimiterTag(tag: number): tag is DelimiterTag {
  return DELIMITER_TAG_VALUES.includes(tag);
}

/** Decode a complete IPP message from a Buffer. */
export function decode(buffer: Buffer): IppMessage {
  const r = new BufferReader(buffer);

  const versionMajor = r.readUInt8();
  const versionMinor = r.readUInt8();
  const operationIdOrStatusCode = r.readUInt16BE();
  const requestId = r.readInt32BE();

  const groups: IppAttributeGroup[] = [];
  let currentGroup: IppAttributeGroup | undefined;
  let lastAttribute: IppAttribute | undefined;

  while (r.hasMore()) {
    const tag = r.readUInt8();

    if (tag === DelimiterTags.END_OF_ATTRIBUTES) {
      break;
    }

    if (isDelimiterTag(tag)) {
      // Start a new attribute group.
      currentGroup = { tag, attributes: [] };
      groups.push(currentGroup);
      lastAttribute = undefined;
      continue;
    }

    // Otherwise this is a value-tag introducing an attribute (or an additional
    // value of the previous attribute when name-length === 0).
    const value = readAttributeValue(r, tag as ValueTag);
    const nameLength = value.nameLength;
    const name = value.name;

    if (nameLength === 0) {
      if (!lastAttribute) {
        throw new IppDecodeError(
          'Additional value (name-length=0) with no preceding attribute'
        );
      }
      lastAttribute.values.push(value.value);
    } else {
      if (!currentGroup) {
        throw new IppDecodeError('Attribute encountered before any group tag');
      }
      const attr: IppAttribute = { name, values: [value.value] };
      currentGroup.attributes.push(attr);
      lastAttribute = attr;
    }
  }

  const data = r.hasMore() ? r.readRemaining() : undefined;

  return {
    versionMajor,
    versionMinor,
    operationIdOrStatusCode,
    requestId,
    groups,
    data,
  };
}

interface DecodedAttributeValue {
  nameLength: number;
  name: string;
  value: IppValue;
}

function readAttributeValue(
  r: BufferReader,
  tag: ValueTag
): DecodedAttributeValue {
  const nameLength = r.readUInt16BE();
  const name = nameLength > 0 ? r.readString(nameLength) : '';
  const valueLength = r.readUInt16BE();
  const raw = r.readBytes(valueLength);

  return {
    nameLength,
    name,
    value: { tag, value: decodeValue(tag, raw) },
  };
}

/** Decode a raw value buffer into a typed JS value based on its tag. */
function decodeValue(
  tag: ValueTag,
  raw: Buffer
): number | boolean | string | Buffer | [number, number] {
  switch (tag) {
    case ValueTags.INTEGER:
    case ValueTags.ENUM:
      return raw.length >= 4 ? raw.readInt32BE(0) : 0;
    case ValueTags.BOOLEAN:
      return raw.length >= 1 ? raw.readUInt8(0) !== 0 : false;
    case ValueTags.RANGE_OF_INTEGER:
      // Two 4-byte big-endian integers: lower then upper bound (inclusive). A
      // short buffer reads the missing bounds as 0 so malformed input is safe.
      return [
        raw.length >= 4 ? raw.readInt32BE(0) : 0,
        raw.length >= 8 ? raw.readInt32BE(4) : 0,
      ];
    case ValueTags.KEYWORD:
    case ValueTags.URI:
    case ValueTags.URI_SCHEME:
    case ValueTags.CHARSET:
    case ValueTags.NATURAL_LANGUAGE:
    case ValueTags.MIME_MEDIA_TYPE:
    case ValueTags.TEXT_WITHOUT_LANG:
    case ValueTags.NAME_WITHOUT_LANG:
      return raw.toString('utf-8');
    case ValueTags.NO_VALUE:
    case ValueTags.UNSUPPORTED:
      return '';
    default:
      // octetString, dateTime, resolution, rangeOfInteger, *WithLang, unknown
      return raw;
  }
}

export class IppDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IppDecodeError';
  }
}
