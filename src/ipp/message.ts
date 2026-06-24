/**
 * IPP Message types + attribute-group helpers.
 *
 * An IPP message (RFC 8010 §3.1.1) shares a common header — version, a 2-byte
 * operation-id (request) or status-code (response), and a 4-byte request-id —
 * followed by a sequence of attribute groups and optional trailing document
 * data. Requests and responses differ only in how the 2-byte field is read.
 */

import type { DelimiterTag } from './constants.js';
import type { IppAttribute } from './attribute.js';
import { DelimiterTags } from './constants.js';
import { findAttr } from './attribute.js';

/** One attribute group, introduced by a delimiter tag. */
export interface IppAttributeGroup {
  tag: DelimiterTag;
  attributes: IppAttribute[];
}

/** Common IPP message shape. */
export interface IppMessage {
  versionMajor: number;
  versionMinor: number;
  /** operation-id for a request, status-code for a response. */
  operationIdOrStatusCode: number;
  requestId: number;
  groups: IppAttributeGroup[];
  /** Trailing document data after the end-of-attributes tag. */
  data?: Buffer;
}

/** Request alias — the 2-byte field is an operation-id. */
export type IppRequest = IppMessage;

/** Response alias — the 2-byte field is a status-code. */
export type IppResponse = IppMessage;

// ── Group helpers ─────────────────────────────────────────────────────────

/** Find the first group with the given delimiter tag. */
export function getGroup(
  msg: IppMessage,
  tag: DelimiterTag
): IppAttributeGroup | undefined {
  return msg.groups.find((g) => g.tag === tag);
}

/** Collect all attributes from every group matching the given tag. */
export function getGroupAttributes(
  msg: IppMessage,
  tag: DelimiterTag
): IppAttribute[] {
  return msg.groups
    .filter((g) => g.tag === tag)
    .flatMap((g) => g.attributes);
}

/** Look up an attribute by name within the operation-attributes group. */
export function getOperationAttribute(
  msg: IppMessage,
  name: string
): IppAttribute | undefined {
  return findAttr(
    getGroupAttributes(msg, DelimiterTags.OPERATION_ATTRIBUTES),
    name
  );
}

/**
 * Build the standard operation-attributes group that every IPP message must
 * lead with: attributes-charset then attributes-natural-language.
 */
export function operationGroup(
  attributes: IppAttribute[]
): IppAttributeGroup {
  return { tag: DelimiterTags.OPERATION_ATTRIBUTES, attributes };
}

export function printerGroup(attributes: IppAttribute[]): IppAttributeGroup {
  return { tag: DelimiterTags.PRINTER_ATTRIBUTES, attributes };
}

export function jobGroup(attributes: IppAttribute[]): IppAttributeGroup {
  return { tag: DelimiterTags.JOB_ATTRIBUTES, attributes };
}
