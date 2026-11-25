import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { lintStream } from '../src/index.ts';
import { lintReadable } from '../src/node.ts';
import { inspectGzip } from '../src/core/gzip.ts';
import { bgzip } from './helpers/bgzf.ts';

let text = '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n';
for (let i = 1; i <= 30000; i++) text += `1\t${i}\t.\tA\tT\t.\t.\t.\n`;
const raw = Buffer.from(text);
const LINES = 30002;

/** Feed bytes in awkward chunk sizes, as a web stream and as a Node stream. */
const web = (b: Uint8Array, size: number) => new ReadableStream<Uint8Array>({
  start(c) { for (let i = 0; i < b.length; i += size) c.enqueue(b.subarray(i, Math.min(b.length, i + size))); c.close(); },
});
const node = (b: Uint8Array, size: number) => Readable.from((function* () { for (let i = 0; i < b.length; i += size) yield Buffer.from(b.subarray(i, Math.min(b.length, i + size))); })());

const cases: [string, Uint8Array, string[], number | null][] = [
  ['plain text', raw, [], LINES],
  ['BGZF, many blocks', bgzip(raw, { blockSize: 20000 }), [], LINES],
  ['BGZF without the end-of-file block', bgzip(raw, { eof: false }), ['GZ002'], LINES],
  ['single-member gzip', gzipSync(raw), ['GZ003'], LINES],
  ['two concatenated gzip members', Buffer.concat([gzipSync(raw.subarray(0, 70001)), gzipSync(raw.subarray(70001))]), ['GZ003'], LINES],
  ['five concatenated gzip members', Buffer.concat([0, 1, 2, 3, 4].map((k) => gzipSync(raw.subarray(Math.floor((raw.length * k) / 5), Math.floor((raw.length * (k + 1)) / 5))))), ['GZ003'], LINES],
  ['truncated gzip', gzipSync(raw).subarray(0, 40000), ['GZ001'], null],
  ['truncated BGZF', bgzip(raw).subarray(0, 30000), ['GZ001'], null],
];

for (const [name, bytes, codes, lines] of cases) {
  for (const size of [977, 65536, bytes.length]) {
    test(`${name}: web stream, ${size}-byte chunks`, async () => {
      const r = await lintStream(web(bytes, size), { filename: 'x.vcf.gz' });
      assert.deepEqual(r.diagnostics.map((d) => d.code), codes);
      if (lines !== null) assert.equal(r.lines, lines); else assert.ok(r.lines > 100 && r.lines < LINES);
    });
    test(`${name}: Node stream, ${size}-byte chunks`, async () => {
      const r = await lintReadable(node(bytes, size), { filename: 'x.vcf.gz' });
      assert.deepEqual(r.diagnostics.map((d) => d.code), codes);
      if (lines !== null) assert.equal(r.lines, lines); else assert.ok(r.lines > 100 && r.lines < LINES);
    });
  }
}

test('inspectGzip tells BGZF from plain gzip from text', () => {
  assert.deepEqual(inspectGzip(bgzip(raw)), { gzip: true, bgzf: true });
  assert.deepEqual(inspectGzip(gzipSync(raw)), { gzip: true, bgzf: false });
  assert.deepEqual(inspectGzip(raw), { gzip: false, bgzf: false });
});
