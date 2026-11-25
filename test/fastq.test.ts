import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFixes, createLinter, findRule, lintText } from '../src/index.ts';
import type { LintOptions, LintResult } from '../src/index.ts';
import { GOOD_FASTQ_EXAMPLES } from '../src/formats/fastq/rules.ts';
import { NAME_BLOCK } from '../src/formats/fastq/index.ts';
import { comparePair } from '../src/formats/fastq/pair.ts';

const codes = (r: LintResult) => r.diagnostics.map((d) => d.code);
const summary = (r: LintResult) => r.diagnostics.map((d) => `${d.code}@${d.line}:${d.column}-${d.endColumn} ${d.message}`);
const fq = (text: string | Uint8Array, opts: LintOptions = {}) => lintText(text, { format: 'fastq', maxPerRule: 0, ...opts });
const rec = (name: string, seq = 'ACGTACGT', qual = 'I'.repeat(seq.length)) => `@${name}\n${seq}\n+\n${qual}\n`;

function chunked(text: string, size: number): LintResult {
  const bytes = new TextEncoder().encode(text);
  const linter = createLinter({ format: 'fastq', maxPerRule: 0 });
  for (let i = 0; i < bytes.length; i += size) linter.push(bytes.subarray(i, Math.min(bytes.length, i + size)));
  return linter.end();
}

/** Reference implementation of the published digest: 64-bit FNV-1a over each normalised name followed by a newline. */
function referenceDigest(names: string[]): string {
  let h = 0xcbf29ce484222325n;
  for (const name of names) {
    const norm = name.split(/[ \t]/)[0]!.replace(/\/[12]$/, '');
    for (const byte of new TextEncoder().encode(norm + '\n')) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

test('valid FASTQ examples produce no diagnostics, in both profiles', () => {
  for (const text of GOOD_FASTQ_EXAMPLES) {
    for (const profile of ['default', 'strict'] as const) {
      const r = lintText(text, { filename: 'ok.fastq', profile });
      assert.deepEqual(summary(r), [], profile);
      assert.equal(r.format, 'fastq');
    }
  }
});

test('the format is recognised from the file name and from the content, and SAM is not mistaken for it', () => {
  for (const name of ['a.fq', 'a.fastq', 'A_R1_001.fastq.gz', 'a.fq.bgz']) {
    const r = lintText(rec('r1'), { filename: name });
    assert.equal(r.format, 'fastq', name);
    assert.equal(r.formatSource, 'extension', name);
  }
  const byContent = lintText(rec('r1') + rec('r2'), { filename: 'reads.txt' });
  assert.equal(byContent.format, 'fastq');
  assert.equal(byContent.formatSource, 'content');
  assert.notEqual(lintText('@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr1\tLN:1000\n@PG\tID:bwa\n', { filename: 'x.txt' }).format, 'fastq');
  // A FASTA file is not FASTQ, and a FASTQ file named .fa is still recognised.
  assert.equal(lintText('>s\nACGT\n', { filename: 'x.txt' }).format, 'fasta');
  assert.equal(lintText(rec('r1') + rec('r2'), { filename: 'reads.fa' }).format, 'fastq');
});

test('statistics: reads, bases and encoding', () => {
  const r = fq(rec('a', 'ACGT', 'II5#') + rec('b', 'ACGTAC', 'FFFFFF'));
  assert.equal(r.stats['reads'], 2);
  assert.equal(r.stats['bases'], 10);
  assert.equal(r.stats['encoding'], 'Phred+33');
  assert.equal(r.stats['nameCheckpoints'], '');
});

test('the name digest is 64-bit FNV-1a over normalised names, with a checkpoint every 4096 reads', () => {
  const names = Array.from({ length: 2 * NAME_BLOCK + 500 }, (_, i) => `M0${i % 7}:12:FC${(i * 2654435761) >>> 0}:1:${i}`);
  const r = fq(names.map((n) => rec(n)).join(''));
  assert.equal(r.stats['reads'], names.length);
  assert.equal(r.stats['nameDigest'], referenceDigest(names));
  const cp = r.stats['nameCheckpoints'] as string;
  assert.equal(cp.length, 32);
  assert.equal(cp.slice(0, 16), referenceDigest(names.slice(0, NAME_BLOCK)));
  assert.equal(cp.slice(16), referenceDigest(names.slice(0, 2 * NAME_BLOCK)));
  // Bytes above 0x7f in names go through the same arithmetic.
  assert.equal(fq(rec('réad/1') + rec('读段2')).stats['nameDigest'], referenceDigest(['réad', '读段2']));
});

test('name normalisation: /1, /2 and everything after the first whitespace are ignored; order matters', () => {
  const d = (...names: string[]) => fq(names.map((n) => rec(n)).join('')).stats['nameDigest'];
  assert.equal(d('frag1/1', 'frag2/1'), d('frag1/2', 'frag2/2'));
  assert.equal(d('frag1 1:N:0:ACGT', 'frag2 1:N:0:ACGT'), d('frag1 2:N:0:ACGT', 'frag2\t2:N:0:TTTT'));
  assert.equal(d('frag1/1', 'frag2/1'), referenceDigest(['frag1', 'frag2']));
  assert.notEqual(d('frag1', 'frag2'), d('frag2', 'frag1'));
  assert.notEqual(d('ab', 'c'), d('a', 'bc'));
  assert.notEqual(d('frag1/3'), d('frag1'));
});

test('comparePair: matching mates produce nothing', () => {
  const names = Array.from({ length: 5000 }, (_, i) => `run:1:${i}`);
  const r1 = fq(names.map((n) => rec(`${n}/1`)).join(''), { filename: 'data/s_R1.fastq' });
  const r2 = fq(names.map((n) => rec(`${n}/2`, 'TTTT')).join(''), { filename: 'data/s_R2.fastq' });
  assert.deepEqual(comparePair(r1, r2), []);
  const c1 = fq(names.map((n) => rec(`${n} 1:N:0:AAA`)).join(''));
  const c2 = fq(names.map((n) => rec(`${n} 2:N:0:AAA`)).join(''));
  assert.deepEqual(comparePair(c1, c2), []);
});

test('comparePair: different read counts are reported on the second file, with a truncation hint when names agree', () => {
  const names = Array.from({ length: 10_000 }, (_, i) => `run:1:${i}`);
  const r1 = fq(names.map((n) => rec(`${n}/1`)).join(''), { filename: '/data/s_R1.fastq.gz' });
  const r2 = fq(names.slice(0, 9000).map((n) => rec(`${n}/2`)).join(''), { filename: '/data/s_R2.fastq.gz' });
  const d = comparePair(r1, r2);
  assert.deepEqual(d.map((x) => [x.code, x.name, x.severity, x.line, x.column]), [['FQ020', 'pair-count-mismatch', 'error', 0, 0]]);
  assert.match(d[0]!.message, /this file has 9,000 reads but its mate `s_R1\.fastq\.gz` has 10,000/);
  assert.match(d[0]!.hint!, /first 8,192 reads.*truncated/);
  assert.equal(d[0]!.spec, findRule('FQ020')!.spec);
  // Reported from the point of view of whichever file is second.
  assert.match(comparePair(r2, r1)[0]!.message, /this file has 10,000 reads but its mate `s_R2\.fastq\.gz` has 9,000/);
});

test('comparePair: diverging names are located to a block of 4096 reads', () => {
  const names = Array.from({ length: 10_000 }, (_, i) => `run:1:${i}`);
  const swapped = names.slice();
  [swapped[5000], swapped[5001]] = [swapped[5001]!, swapped[5000]!];
  const r1 = fq(names.map((n) => rec(`${n}/1`)).join(''), { filename: 'R1.fq' });
  const r2 = fq(swapped.map((n) => rec(`${n}/2`)).join(''), { filename: 'R2.fq' });
  const d = comparePair(r1, r2);
  assert.deepEqual(d.map((x) => [x.code, x.name, x.severity, x.line]), [['FQ021', 'pair-name-mismatch', 'error', 0]]);
  assert.match(d[0]!.message, /mate `R1\.fq`.*reads 4,097-8,192/);
  assert.match(d[0]!.hint!, /first 4,096 reads have the same names/);

  // A difference after the last full block is located to the tail.
  const tail = names.slice();
  tail[9999] = 'something:else';
  const t = comparePair(r1, fq(tail.map((n) => rec(`${n}/2`)).join(''), { filename: 'R2.fq' }));
  assert.deepEqual(t.map((x) => x.code), ['FQ021']);
  assert.match(t[0]!.message, /reads 8,193-10,000/);

  // In the first block of a small pair.
  const s = comparePair(fq(rec('a/1') + rec('b/1')), fq(rec('a/2') + rec('c/2')));
  assert.match(s[0]!.message, /reads 1-2/);
});

test('comparePair: a shorter file whose names also differ gets both findings', () => {
  const names = Array.from({ length: 9000 }, (_, i) => `run:1:${i}`);
  const r1 = fq(names.map((n) => rec(`${n}/1`)).join(''));
  const r2 = fq(names.filter((_, i) => i !== 100).map((n) => rec(`${n}/2`)).join(''));
  const d = comparePair(r1, r2);
  assert.deepEqual(d.map((x) => x.code), ['FQ020', 'FQ021']);
  assert.match(d[1]!.message, /reads 1-4,096/);
  assert.doesNotMatch(d[0]!.hint!, /probably truncated/);
});

test('comparePair: results without FASTQ statistics are not compared', () => {
  const ok = fq(rec('a/1'));
  assert.deepEqual(comparePair(ok, lintText('', { format: 'fastq' })), []);
  assert.deepEqual(comparePair(lintText('>a\nACGT\n', { format: 'fasta' }), ok), []);
});

test('results do not depend on how the input is cut into chunks', () => {
  const text = rec('a/1') + rec('a/2', 'ACGT ACG') + '\n' + rec('b', 'ACGTNN', 'IIIII') + '@c\nACGT\nIIII\n' + rec('d', '', '') + rec('e', 'AC.T', 'II\tI')
    + '@f\nACGTAC\nGTACGT\n+f\n@III+I\n+IIIII\n' + rec('g', 'ACGT', 'hhhh') + 'ACGT\n+\nIIII\n' + '@h\nACGT\n+\n';
  const whole = fq(text);
  assert.ok(whole.diagnostics.length >= 8, summary(whole).join('\n'));
  for (const size of [1, 2, 3, 5, 7, 16, 61]) {
    const r = chunked(text, size);
    assert.deepEqual(summary(r), summary(whole), `chunk size ${size}`);
    assert.deepEqual(r.stats, whole.stats, `chunk size ${size}`);
  }
});

test('line-wrapped records are read as the format defines them, with one warning each', () => {
  // Quality lines that start with `@` and `+`, and quality wrapped differently from the sequence.
  const text = '@r1 wrapped\nACGTACGTAC\nGTACGTACGT\nACGT\n+r1 wrapped\nIIIIIIIIII\n@IIIIIIIII\n+III\n'
    + '@r2\nACGTACGTACGTACGTACGT\n+\n@IIIII\n@IIIIIII\n+IIIII\n'
    + rec('r3');
  const r = fq(text);
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.severity, d.line]), [['FQ008', 'warning', 3], ['FQ008', 'warning', 13]]);
  assert.equal(r.stats['reads'], 3);
  assert.equal(r.stats['bases'], 24 + 20 + 8);
  assert.equal(fq(text, { profile: 'strict' }).counts.error, 0);
});

test('a truncated final record says which lines are missing', () => {
  const full = rec('r1');
  const cases: [string, RegExp][] = [
    ['@r2\n', /ends inside read `r2`: the sequence, `\+` and quality lines are missing/],
    ['@r2\nACGT\n', /ends inside read `r2`: the `\+` and quality lines are missing/],
    ['@r2\nACGT\n+\n', /ends inside read `r2`: the quality line is missing/],
    ['@r2\nACGTACGT\n+\nIIII\n', /ends inside read `r2`: the quality stops after 4 of 8 characters/],
  ];
  for (const [tail, re] of cases) {
    const r = fq(full + tail);
    assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line]), [['FQ007', 5]], tail);
    assert.match(r.diagnostics[0]!.message, re);
    assert.equal(r.stats['reads'], 1);
  }
  // Cut in the middle of a line: the generic rule reports the missing newline as well.
  assert.deepEqual(codes(fq(full + '@r2\nACGTACGT\n+\nIII')).sort(), ['FQ007', 'TXT009']);
});

test('a lost line costs one diagnostic and the following records are still read', () => {
  const after = rec('r3 x') + rec('r4 x');
  // quality line missing
  let r = fq(rec('r1 x') + '@r2 x\nACGTACGT\n+\n' + after);
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line]), [['FQ007', 5]]);
  assert.match(r.diagnostics[0]!.message, /read `r2` has no quality line: the next record starts on line 8/);
  assert.equal(r.stats['reads'], 3);
  // `+` line missing
  r = fq(rec('r1 x') + '@r2 x\nACGTACGT\nIIIIIII#\n' + after);
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line]), [['FQ002', 7]]);
  assert.match(r.diagnostics[0]!.hint!, /insert a `\+` line/);
  assert.equal(r.stats['reads'], 3);
  // title line missing
  r = fq(rec('r1 x') + 'ACGTACGT\n+\nIIIIIIII\n' + after);
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line, d.column]), [['FQ001', 5, 1]]);
  assert.equal(r.stats['reads'], 3);
  // sequence line missing as well
  r = fq(rec('r1 x') + '@r2 x\n' + after);
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line]), [['FQ007', 6]]);
  assert.equal(r.stats['reads'], 3);
  // quality too short, in the middle of a four-line file
  r = fq(rec('r1 x') + '@r2 x\nACGTACGT\n+\nIIIII\n' + after);
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line]), [['FQ004', 8]]);
  assert.equal(r.stats['reads'], 4);
  // ... also when the next title has no whitespace and happens to be exactly as long as the missing quality (`@r3`)
  r = fq(rec('r1') + '@r2\nACGTACGT\n+\nIIIII\n' + rec('r3') + rec('r4'));
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line]), [['FQ004', 8]]);
  assert.equal(r.stats['reads'], 4);
  // In a wrapped file the same line is quality: the last quality line of r2 is `@II`.
  r = fq('@r1\nACGTACGT\nACGT\n+\nIIIIIIII\nIIII\n' + '@r2\nACGTACGT\n+\nIIIII\n@II\n' + rec('r3'));
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line]), [['FQ008', 3], ['FQ008', 11]]);
  assert.equal(r.stats['reads'], 3);
});

test('a quality string that starts with @ is not mistaken for a title', () => {
  const r = fq(rec('r1', 'ACGTACGT', '@IIIIIII') + rec('r2', 'ACGT', '@@@@') + rec('r3', 'ACGTAC', '@+@+@+'));
  assert.deepEqual(codes(r), []);
  assert.equal(r.stats['reads'], 3);
  // ... also when it has the wrong length: the mismatch is reported on that line.
  const bad = fq(rec('r1') + '@r2\nACGT\n+\n@IIIIIII\n' + rec('r3'));
  assert.deepEqual(bad.diagnostics.map((d) => [d.code, d.line]), [['FQ004', 8]]);
  assert.equal(bad.stats['reads'], 3);
});

test('quality encoding is decided conservatively', () => {
  const enc = (q: string) => { const r = fq(rec('r1', 'A'.repeat(q.length), q)); return [r.stats['encoding'], codes(r).join()]; };
  assert.deepEqual(enc('IIIIIIIIIIFFFFF5,#'), ['Phred+33', '']);
  // One constant character says nothing: synthetic files use I, F, E, h, ~ ...
  for (const c of ['I', 'F', 'E', 'J', 'h', '~', '@']) assert.deepEqual(enc(c.repeat(30)), ['Phred+33', ''], c);
  // High-accuracy long reads: nothing low, but far above anything a +64 file contains.
  assert.deepEqual(enc('~~~~~~~~~~~~~~~~~~~~<FFFn~~~'), ['Phred+33', '']);
  // Everything between `;` and `J` is ordinary Phred+33 (Q26-Q41).
  assert.deepEqual(enc('JJJJJJJJAAAAFFFF<<<;;'), ['Phred+33', '']);
  // Illumina 1.5: B is the floor, h the ceiling.
  assert.deepEqual(enc('hhhhhhhhgggfffeeedddBBBB'), ['Phred+64', 'FQ009']);
  // Solexa: scores below zero use ; to ?.
  assert.deepEqual(enc('hhhhhhhhhhhhXXXXXMMMM@@@;;;'), ['Solexa+64', 'FQ009']);
  const r = fq(rec('r1', 'A'.repeat(24), 'hhhhhhhhgggfffeeedddBBBB'), { profile: 'strict' });
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.severity, d.line]), [['FQ009', 'warning', 0]]);
  assert.match(r.diagnostics[0]!.hint!, /seqtk seq -Q64 -V/);
  assert.equal(fq('@r\n\n+\n\n').stats['encoding'], 'unknown');
});

test('zero-length reads are valid records; blank lines after the last record are trailing blank lines', () => {
  const r = fq(rec('r1') + '@empty\n\n+\n\n' + rec('r3') + '\n\n');
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.severity, d.line]), [['FQ010', 'warning', 6], ['TXT013', 'warning', 13]]);
  assert.equal(r.stats['reads'], 3);
  assert.equal(r.counts.error, 0);
  // A zero-length read at the very end is not confused with trailing blank lines.
  assert.deepEqual(codes(fq(rec('r1') + '@empty\n\n+\n\n')), ['FQ010']);
  // --fix removes trailing blank lines, and must leave the empty quality line of a final zero-length read alone.
  const enc = new TextEncoder(), dec = new TextDecoder();
  const plain = rec('r1') + '\n\n';
  const fixedPlain = applyFixes(enc.encode(plain), fq(plain).diagnostics);
  assert.equal(dec.decode(fixedPlain.output), rec('r1'));
  const endsEmpty = rec('r1') + '@empty\n\n+\n\n' + '\n\n';
  const res = fq(endsEmpty);
  assert.deepEqual(codes(res), ['FQ010', 'TXT013']);
  assert.equal(res.diagnostics[1]!.fix, undefined);
  assert.match(res.diagnostics[1]!.hint!, /keep the empty quality line/);
  assert.equal(dec.decode(applyFixes(enc.encode(endsEmpty), res.diagnostics).output), endsEmpty);
  // Blank lines between records are a defect of their own, reported once per gap.
  const gap = fq(rec('r1') + '\n\n' + rec('r2'));
  assert.deepEqual(gap.diagnostics.map((d) => [d.code, d.severity, d.line]), [['FQ012', 'error', 5]]);
  assert.equal(gap.stats['reads'], 2);
});

test('the + line may repeat the title, and a different repeat is located at the first differing character', () => {
  assert.deepEqual(codes(fq('@r1 desc\nACGT\n+r1 desc\nIIII\n')), []);
  const r = fq('@read_one desc\nACGT\n+read_two desc\nIIII\n');
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.severity, d.line, d.column]), [['FQ003', 'warning', 3, 7]]);
  assert.equal(fq('@r1\nACGT\n+r2\nIIII\n', { profile: 'strict' }).diagnostics[0]!.severity, 'error');
});

test('sequence characters: IUPAC codes in either case and gaps pass; other characters are warnings, whitespace is an error', () => {
  assert.deepEqual(codes(fq(rec('r1', 'ACGTUNRYKMSWBDHVacgtunrykmswbdhv-'))), []);
  const r = fq(rec('r1', 'ACGT.ACGTXACGT', 'IIIIIIIIIIIIII'));
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.severity, d.column]), [['FQ006', 'warning', 5], ['FQ006', 'warning', 10]]);
  assert.match(r.diagnostics[0]!.hint!, /`N`/);
  assert.equal(fq(rec('r1', 'ACGT.ACG'), { profile: 'strict' }).counts.error, 0);
  const cs = fq(rec('r1', 'T0120.3211', 'IIIIIIIIII'));
  assert.equal(cs.diagnostics.length, 1);
  assert.match(cs.diagnostics[0]!.message, /colour space/);
  const ws = fq(rec('r1', 'ACGT\tACG', 'IIIIIIII') + rec('r2', 'ACGTACGT', 'IIII III'));
  assert.deepEqual(ws.diagnostics.map((d) => [d.code, d.severity, d.line, d.column]), [['FQ011', 'error', 2, 5], ['FQ011', 'error', 8, 5]]);
});

test('interleaved pairs are checked only when the first two reads are marked as mates', () => {
  const pair = (n: string) => rec(`${n}/1`) + rec(`${n}/2`);
  assert.deepEqual(codes(fq(pair('a') + pair('b') + pair('c'))), []);
  assert.deepEqual(codes(fq(rec('a 1:N:0:AC') + rec('a 2:N:0:AC') + rec('b 1:N:0:AC') + rec('b 2:N:0:AC'))), []);
  const off = fq(pair('a') + rec('b/1') + pair('c') + rec('d/2'));
  assert.deepEqual(off.diagnostics.map((d) => [d.code, d.line, d.column, d.endColumn]), [['FQ021', 13, 2, 3]]);
  assert.deepEqual(codes(fq(pair('a') + rec('b/1'))), ['FQ020']);
  // Every read written twice, or names without mate markers: not an interleaved file, nothing to say.
  assert.deepEqual(codes(fq(rec('a 1:N:0:AC') + rec('a 1:N:0:AC') + rec('b 1:N:0:AC'))), []);
  assert.deepEqual(codes(fq(rec('a') + rec('a') + rec('b'))), []);
  assert.deepEqual(codes(fq(rec('a/1') + rec('b/1') + rec('c/1'))), []);
});

test('a read of several megabases is one record', () => {
  const n = 3_000_000;
  const bytes = new Uint8Array(5 + n + 3 + n + 1);
  bytes.set(new TextEncoder().encode('@ont\n'), 0);
  bytes.fill(71, 5, 5 + n);
  bytes.set(new TextEncoder().encode('\n+\n'), 5 + n);
  bytes.fill(53, 5 + n + 3, 5 + n + 3 + n);
  bytes[5 + n + 3 + n] = 10;
  const r = fq(bytes);
  assert.deepEqual(codes(r), []);
  assert.equal(r.stats['bases'], n);
  bytes[5 + 2_000_000] = 32;
  const bad = fq(bytes);
  assert.deepEqual(bad.diagnostics.map((d) => [d.code, d.line, d.column]), [['FQ011', 2, 2_000_001]]);
});

test('memory does not grow with the number of reads', () => {
  const linter = createLinter({ format: 'fastq' });
  const enc = new TextEncoder();
  const before = process.memoryUsage().heapUsed;
  let block = '';
  const total = 400_000;
  for (let i = 0; i < total; i++) {
    block += `@inst:7:FC1:1:${i >> 10}:${i & 1023}:${i} 1:N:0:ACGT\nACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT\n+\nIIIIIIIIIIIIIIIIIIIIFFFFFFFFFF55555,,,,,\n`;
    if (block.length > 1 << 20) { linter.push(enc.encode(block)); block = ''; }
  }
  linter.push(enc.encode(block));
  const r = linter.end();
  assert.deepEqual(codes(r), []);
  assert.equal(r.stats['reads'], total);
  assert.equal((r.stats['nameCheckpoints'] as string).length, 16 * Math.floor(total / NAME_BLOCK));
  const grown = process.memoryUsage().heapUsed - before;
  // 50 MB of input; without a forced collection this is a coarse bound, not a measurement.
  assert.ok(grown < 200 * 1024 * 1024, `heap grew by ${(grown / 1048576).toFixed(0)} MB`);
});
