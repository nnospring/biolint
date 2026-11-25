import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, codePointIndex, decodeLatin1 } from '../src/core/reader.ts';
import { applyFixes, lintText } from '../src/index.ts';

function split(chunks: (string | Uint8Array)[], maxPiece?: number, discard?: boolean) {
  const out: { text: string; offset: number; crlf: boolean; partial: boolean; continued: boolean; terminated: boolean }[] = [];
  const s = new LineSplitter((b, offset, crlf, partial, continued, terminated) => out.push({ text: decodeLatin1(b), offset, crlf, partial, continued, terminated }), maxPiece, discard);
  for (const c of chunks) s.push(typeof c === 'string' ? new TextEncoder().encode(c) : c);
  const unterminated = s.end();
  return { out, unterminated };
}

test('LineSplitter: lines across chunk boundaries, CRLF, offsets', () => {
  const { out, unterminated } = split(['ab', 'c\nde\r', '\n', '\nlast']);
  assert.deepEqual(out.map((l) => l.text), ['abc', 'de', '', 'last']);
  assert.deepEqual(out.map((l) => l.offset), [0, 4, 8, 9]);
  assert.deepEqual(out.map((l) => l.crlf), [false, true, false, false]);
  assert.deepEqual(out.map((l) => l.terminated), [true, true, true, false]);
  assert.equal(unterminated, true);
});

test('LineSplitter: every split of a text gives the same lines', () => {
  const text = 'one\r\ntwo\n\nthree\r\n\r\nfour';
  const whole = split([text]).out;
  for (let i = 1; i < text.length; i++) for (let j = i; j < text.length; j += 3) {
    assert.deepEqual(split([text.slice(0, i), text.slice(i, j), text.slice(j)]).out, whole, `split at ${i},${j}`);
  }
});

test('LineSplitter: long lines are delivered in pieces that reassemble exactly', () => {
  const long = 'x'.repeat(1000) + '\r\nshort\n';
  for (const size of [7, 64, 333]) {
    const chunks: string[] = [];
    for (let i = 0; i < long.length; i += size) chunks.push(long.slice(i, i + size));
    const { out } = split(chunks, 100);
    const first = out.filter((l) => l.text !== 'short');
    assert.equal(first.map((l) => l.text).join(''), 'x'.repeat(1000));
    assert.ok(first.length > 1 && first.slice(0, -1).every((l) => l.partial) && !first[first.length - 1]!.partial);
    assert.ok(first.slice(1).every((l) => l.continued));
    assert.equal(first[first.length - 1]!.crlf, true);
    assert.equal(out[out.length - 1]!.text, 'short');
    assert.equal(out[out.length - 1]!.offset, 1002);
  }
});

test('LineSplitter: oversized lines can be dropped without buffering them', () => {
  const { out } = split(['head\n', 'y'.repeat(50), 'y'.repeat(500), 'yy\nnext\n'], 100, true);
  assert.deepEqual(out.map((l) => [l.text, l.partial, l.continued]), [['head', false, false], ['', true, false], ['', false, true], ['next', false, false]]);
  assert.equal(out[3]!.offset, 5 + 552 + 1);
});

test('columns count code points, byteColumn counts bytes', () => {
  assert.equal(codePointIndex(new TextEncoder().encode('é中x'), 5), 2);
  const r = lintText('##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n染色体1\tx\t.\tA\tT\t.\t.\t.\n', { filename: 'a.vcf' });
  const d = r.diagnostics.find((x) => x.code === 'VCF205')!;
  assert.equal(d.column, 6);
  assert.equal(d.byteColumn, 12);
  assert.equal(d.excerpt!.text.slice(d.excerpt!.column - 1, d.excerpt!.endColumn - 1), 'x');
});

test('occurrences beyond the per-rule cap are counted, not listed', () => {
  let text = '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n';
  for (let i = 1; i <= 50; i++) text += `1\t${i}\t.\tA\tT\tbad\t.\t.\n`;
  const r = lintText(text, { filename: 'a.vcf', maxPerRule: 3 });
  assert.equal(r.diagnostics.filter((d) => d.code === 'VCF215').length, 3);
  assert.deepEqual(r.byRule['VCF215'], { count: 50, shown: 3, severity: 'error', fixable: false });
  assert.equal(r.counts.error, 50);
});

test('select and ignore accept codes, prefixes, names and format ids', () => {
  const text = '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1\t1\t.\tA\tT\tbad\tq\tX=1\n';
  const codes = (o: object) => lintText(text, { filename: 'a.vcf', ...o }).diagnostics.map((d) => d.code).sort();
  assert.deepEqual(codes({}), ['VCF215', 'VCF217', 'VCF304']);
  assert.deepEqual(codes({ select: ['VCF2'] }), ['VCF215', 'VCF217']);
  assert.deepEqual(codes({ ignore: ['qual-invalid', 'VCF304'] }), ['VCF217']);
  assert.deepEqual(codes({ ignore: ['vcf'] }), []);
});

test('text-level problems: BOM, CRLF, UTF-16, binary, look-alike characters, empty file', () => {
  const vcf = '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1\t1\t.\tA\tT\t.\t.\t.\n';
  const codes = (b: string | Uint8Array, name = 'a.vcf') => lintText(b, { filename: name }).diagnostics.map((d) => d.code);
  assert.deepEqual(codes('﻿' + vcf), ['TXT002']);
  assert.deepEqual(codes(vcf.replace(/\n/g, '\r\n')), ['TXT003']);
  assert.deepEqual(codes(vcf.replace('\n', '\r\n')), ['TXT003', 'TXT004']);
  assert.deepEqual(codes(new Uint8Array([0xff, 0xfe, 0x23, 0, 0x23, 0])), ['TXT001']);
  assert.deepEqual(codes(new Uint8Array([0x42, 0x41, 0x4d, 1, 0, 0, 0, 0])), ['TXT011']);
  assert.deepEqual(codes(''), ['TXT010']);
  assert.deepEqual(codes(vcf.slice(0, -1)), ['TXT014']);
  assert.deepEqual(codes('>s\nACGT', 'a.fa'), ['TXT009']);
  assert.deepEqual(codes(vcf + '\n\n'), ['TXT013']);
  const curly = lintText(vcf.replace('1\t1\t.', '1\t1\t“rs1”'), { filename: 'a.vcf' });
  assert.deepEqual(curly.diagnostics.map((d) => d.code), ['TXT008', 'TXT008']);
  assert.match(curly.diagnostics[0]!.message, /U\+201C LEFT DOUBLE QUOTATION MARK/);
});

test('applyFixes repairs BOM, CRLF, look-alike characters, blank tail and missing newline together', () => {
  const broken = '﻿##fileformat=VCFv4.3\r\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\r\n1\t1\t“rs1”\tA\tT\t.\t.\t.\r\n\r\n';
  const bytes = new TextEncoder().encode(broken);
  const r = lintText(bytes, { filename: 'a.vcf', maxPerRule: 0 });
  const fixed = applyFixes(bytes, r.diagnostics);
  assert.equal(new TextDecoder().decode(fixed.output), '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1\t1\t"rs1"\tA\tT\t.\t.\t.\n');
  assert.deepEqual(lintText(fixed.output, { filename: 'a.vcf' }).diagnostics, []);
  const noNl = new TextEncoder().encode('##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO');
  assert.equal(new TextDecoder().decode(applyFixes(noNl, lintText(noNl, { filename: 'a.vcf' }).diagnostics).output).endsWith('INFO\n'), true);
});

test('format detection: extension, content, and a mismatch between them', () => {
  const vcf = '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n';
  assert.equal(lintText(vcf, { filename: 'x.vcf.gz' }).formatSource, 'extension');
  assert.equal(lintText(vcf, { filename: 'mystery.txt' }).formatSource, 'content');
  const unknown = lintText('hello world\n', { filename: 'mystery.txt' });
  assert.equal(unknown.format, 'unknown');
  assert.deepEqual(unknown.diagnostics.map((d) => d.code), ['TXT020']);
});
