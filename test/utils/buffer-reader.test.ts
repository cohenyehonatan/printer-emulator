import { describe, it, expect } from 'vitest';
import { BufferReader, BufferReadError } from '../../src/utils/buffer-reader.js';
import { BufferWriter } from '../../src/utils/buffer-writer.js';

describe('BufferReader', () => {
  it('reads integers of each width big-endian', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x00, 0x00, 0x00, 0x2a]);
    const r = new BufferReader(buf);
    expect(r.readUInt8()).toBe(0x01);
    expect(r.readUInt16BE()).toBe(0x0203);
    expect(r.readInt32BE()).toBe(42);
    expect(r.hasMore()).toBe(false);
  });

  it('reads bytes and strings and tracks position', () => {
    const buf = Buffer.from('hello world', 'utf-8');
    const r = new BufferReader(buf);
    expect(r.readString(5)).toBe('hello');
    expect(r.getPosition()).toBe(5);
    r.readBytes(1); // space
    expect(r.readRemaining().toString('utf-8')).toBe('world');
    expect(r.getRemainingLength()).toBe(0);
  });

  it('peeks without advancing', () => {
    const r = new BufferReader(Buffer.from([0xab, 0xcd]));
    expect(r.peekUInt8()).toBe(0xab);
    expect(r.getPosition()).toBe(0);
  });

  it('throws on over-read', () => {
    const r = new BufferReader(Buffer.from([0x01]));
    expect(() => r.readInt32BE()).toThrow(BufferReadError);
  });

  it('round-trips with BufferWriter', () => {
    const w = new BufferWriter();
    w.writeUInt8(0x02).writeUInt16BE(0x000b).writeInt32BE(7).writeString('ipp');
    const buf = w.toBuffer();
    const r = new BufferReader(buf);
    expect(r.readUInt8()).toBe(0x02);
    expect(r.readUInt16BE()).toBe(0x000b);
    expect(r.readInt32BE()).toBe(7);
    expect(r.readString(3)).toBe('ipp');
  });
});
