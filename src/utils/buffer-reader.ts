/**
 * Cursor-based reader over a binary Buffer.
 *
 * IPP messages (RFC 8010) are a stream of big-endian integers, length-prefixed
 * strings, and opaque byte runs. This reader provides a sequential cursor that
 * advances as fields are consumed — the binary analog of the AEA FieldParser.
 */

export class BufferReader {
  private position = 0;

  constructor(private readonly data: Buffer) {}

  /** Read a single unsigned byte and advance the cursor. */
  readUInt8(): number {
    this.ensure(1);
    const value = this.data.readUInt8(this.position);
    this.position += 1;
    return value;
  }

  /** Read a big-endian unsigned 16-bit integer and advance the cursor. */
  readUInt16BE(): number {
    this.ensure(2);
    const value = this.data.readUInt16BE(this.position);
    this.position += 2;
    return value;
  }

  /** Read a big-endian signed 32-bit integer and advance the cursor. */
  readInt32BE(): number {
    this.ensure(4);
    const value = this.data.readInt32BE(this.position);
    this.position += 4;
    return value;
  }

  /** Read exactly `n` raw bytes and advance the cursor. */
  readBytes(n: number): Buffer {
    this.ensure(n);
    const value = this.data.subarray(this.position, this.position + n);
    this.position += n;
    return value;
  }

  /** Read `n` bytes and decode them as a string (default ASCII/UTF-8). */
  readString(n: number, encoding: BufferEncoding = 'utf-8'): string {
    return this.readBytes(n).toString(encoding);
  }

  /** Read all remaining bytes. */
  readRemaining(): Buffer {
    const value = this.data.subarray(this.position);
    this.position = this.data.length;
    return value;
  }

  /** Peek at the next byte without advancing. */
  peekUInt8(): number {
    this.ensure(1);
    return this.data.readUInt8(this.position);
  }

  /** Check if there are more bytes to read. */
  hasMore(): boolean {
    return this.position < this.data.length;
  }

  /** Current cursor position. */
  getPosition(): number {
    return this.position;
  }

  /** Total length of the underlying buffer. */
  getLength(): number {
    return this.data.length;
  }

  /** Remaining unread byte count. */
  getRemainingLength(): number {
    return this.data.length - this.position;
  }

  private ensure(n: number): void {
    if (this.position + n > this.data.length) {
      throw new BufferReadError(
        `Cannot read ${n} bytes at position ${this.position}, ` +
          `only ${this.data.length - this.position} bytes remaining`,
        this.position
      );
    }
  }
}

export class BufferReadError extends Error {
  constructor(
    message: string,
    public readonly position: number
  ) {
    super(message);
    this.name = 'BufferReadError';
  }
}
