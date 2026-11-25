// Test helper: write BGZF (block gzip) without external tools.
import { crc32, deflateRawSync } from 'node:zlib';

const EOF_BLOCK = Buffer.from('1f8b08040000000000ff0600424302001b0003000000000000000000', 'hex');

function block(data: Uint8Array): Buffer {
  const cdata = deflateRawSync(data, { level: 6 });
  const bsize = cdata.length + 25; // total block size - 1
  const head = Buffer.from([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 0xff, 6, 0, 0x42, 0x43, 2, 0, bsize & 0xff, bsize >> 8]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(data) >>> 0, 0);
  tail.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, cdata, tail]);
}

/** Compress `data` as BGZF with blocks of at most `blockSize` uncompressed bytes. */
export function bgzip(data: Uint8Array, { blockSize = 0xff00, eof = true } = {}): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += blockSize) parts.push(block(data.subarray(i, Math.min(data.length, i + blockSize))));
  if (eof) parts.push(EOF_BLOCK);
  return Buffer.concat(parts);
}
