/**
 * IPP Attribute model + typed value helpers.
 *
 * An IPP attribute (RFC 8010 §3.1.2) is a name plus one or more values, each
 * value carrying a value-tag. A "1setOf" attribute simply has more than one
 * value. This module models that shape and offers constructors for the common
 * value types so callers don't hand-pick tags.
 */

import { ValueTags, type ValueTag } from './constants.js';

/** A single tagged value within an attribute. */
export interface IppValue {
  tag: ValueTag;
  /**
   * Decoded value. integers/enums/booleans are `number`/`boolean`; string
   * families are `string`; octetString and unknown raw values are `Buffer`.
   */
  value: number | boolean | string | Buffer;
}

/** A named attribute holding one (or, for 1setOf, several) values. */
export interface IppAttribute {
  name: string;
  values: IppValue[];
}

// ── Constructors ──────────────────────────────────────────────────────────

export function integerAttr(name: string, value: number): IppAttribute {
  return { name, values: [{ tag: ValueTags.INTEGER, value }] };
}

export function enumAttr(name: string, value: number): IppAttribute {
  return { name, values: [{ tag: ValueTags.ENUM, value }] };
}

/** 1setOf integer (e.g. Cancel-My-Jobs `job-ids`). */
export function integersAttr(name: string, ...values: number[]): IppAttribute {
  return {
    name,
    values: values.map((value) => ({ tag: ValueTags.INTEGER, value })),
  };
}

export function booleanAttr(name: string, value: boolean): IppAttribute {
  return { name, values: [{ tag: ValueTags.BOOLEAN, value }] };
}

export function keywordAttr(name: string, ...values: string[]): IppAttribute {
  return {
    name,
    values: values.map((v) => ({ tag: ValueTags.KEYWORD, value: v })),
  };
}

export function uriAttr(name: string, value: string): IppAttribute {
  return { name, values: [{ tag: ValueTags.URI, value }] };
}

export function charsetAttr(name: string, value: string): IppAttribute {
  return { name, values: [{ tag: ValueTags.CHARSET, value }] };
}

export function naturalLanguageAttr(name: string, value: string): IppAttribute {
  return { name, values: [{ tag: ValueTags.NATURAL_LANGUAGE, value }] };
}

export function mimeMediaTypeAttr(
  name: string,
  ...values: string[]
): IppAttribute {
  return {
    name,
    values: values.map((v) => ({ tag: ValueTags.MIME_MEDIA_TYPE, value: v })),
  };
}

export function nameWithoutLangAttr(name: string, value: string): IppAttribute {
  return { name, values: [{ tag: ValueTags.NAME_WITHOUT_LANG, value }] };
}

export function textWithoutLangAttr(name: string, value: string): IppAttribute {
  return { name, values: [{ tag: ValueTags.TEXT_WITHOUT_LANG, value }] };
}

// ── Accessors ─────────────────────────────────────────────────────────────

/** First value of an attribute as a string, or undefined. */
export function firstString(attr: IppAttribute | undefined): string | undefined {
  const v = attr?.values[0]?.value;
  return typeof v === 'string' ? v : undefined;
}

/** First value of an attribute as a number, or undefined. */
export function firstNumber(attr: IppAttribute | undefined): number | undefined {
  const v = attr?.values[0]?.value;
  return typeof v === 'number' ? v : undefined;
}

/** First value of an attribute as a boolean, or undefined. */
export function firstBoolean(
  attr: IppAttribute | undefined
): boolean | undefined {
  const v = attr?.values[0]?.value;
  return typeof v === 'boolean' ? v : undefined;
}

/** Every string value of an attribute (e.g. a 1setOf keyword), in order. */
export function allStrings(attr: IppAttribute | undefined): string[] {
  if (!attr) return [];
  return attr.values
    .map((v) => v.value)
    .filter((v): v is string => typeof v === 'string');
}

/** Find an attribute by name within a flat list. */
export function findAttr(
  attrs: IppAttribute[],
  name: string
): IppAttribute | undefined {
  return attrs.find((a) => a.name === name);
}
