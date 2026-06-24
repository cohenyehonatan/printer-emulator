/**
 * Growable binary Buffer builder.
 *
 * Accumulates big-endian integers, length-prefixed strings, and opaque byte
 * runs into a single Buffer for IPP message encoding (RFC 8010). Grows its
 * backing store on demand, then yields a tightly-sized Buffer via toBuffer().
 */

export class BufferWriter {
  private chunks: Buffer[] = [];

  /** Append a single unsigned byte. */
  writeUInt8(value: number): this {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(value & 0xff, 0);
    this.chunks.push(b);
    return this;
  }

  /** Append a big-endian unsigned 16-bit integer. */
  writeUInt16BE(value: number): this {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(value & 0xffff, 0);
    this.chunks.push(b);
    return this;
  }

  /** Append a big-endian signed 32-bit integer. */
  writeInt32BE(value: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(value | 0, 0);
    this.chunks.push(b);
    return this;
  }

  /** Append raw bytes. */
  writeBytes(bytes: Buffer): this {
    this.chunks.push(bytes);
    return this;
  }

  /** Append a string in the given encoding (default ASCII/UTF-8). */
  writeString(value: string, encoding: BufferEncoding = 'utf-8'): this {
    this.chunks.push(Buffer.from(value, encoding));
    return this;
  }

  /** Total number of bytes written so far. */
  length(): number {
    return this.chunks.reduce((sum, c) => sum + c.length, 0);
  }

  /** Collapse all chunks into a single contiguous Buffer. */
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
