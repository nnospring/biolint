import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFixes, createLinter, lintText } from '../src/index.ts';
import type { LintOptions, LintResult } from '../src/index.ts';
import { GOOD_FASTA_EXAMPLES } from '../src/formats/fasta/rules.ts';

const codes = (r: LintResult) => r.diagnostics.map((d) => d.code);
const summary = (r: LintResult) => r.diagnostics.map((d) => `${d.code}@${d.line}:${d.column}-${d.endColumn} ${d.message}`);
const fa = (text: string | Uint8Array, opts: LintOptions = {}) => lintText(text, { format: 'fasta', maxPerRule: 0, ...opts });

/** Lint the same bytes delivered in chunks of a given size. */
function chunked(text: string, size: number, opts: LintOptions = {}): LintResult {
  const bytes = new TextEncoder().encode(text);
  const linter = createLinter({ format: 'fasta', maxPerRule: 0, ...opts });
  for (let i = 0; i < bytes.length; i += size) linter.push(bytes.subarray(i, Math.min(bytes.length, i + size)));
  return linter.end();
}

/** Deterministic pseudo-random DNA. */
function dna(n: number, seed = 1): string {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; out[i] = 'ACGT'.charCodeAt(s >>> 30); }
  return new TextDecoder().decode(out);
}

test('valid FASTA examples produce no diagnostics, in both profiles', () => {
  for (const text of GOOD_FASTA_EXAMPLES) {
    for (const profile of ['default', 'strict'] as const) {
      const r = lintText(text, { filename: 'ok.fasta', profile });
      assert.deepEqual(summary(r), [], profile);
      assert.equal(r.format, 'fasta');
    }
  }
});

test('the format is recognised from the file name and from the content', () => {
  for (const name of ['a.fa', 'a.fasta', 'a.fna', 'a.faa', 'a.ffn', 'a.frn', 'a.fas', 'a.mfa', 'A.FASTA.gz', 'genome.fa.bgz']) {
    const r = lintText('>s\nACGT\n', { filename: name });
    assert.equal(r.format, 'fasta', name);
    assert.equal(r.formatSource, 'extension', name);
  }
  const byContent = lintText('\n>s some description\nACGT\n', { filename: 'sequences.txt' });
  assert.equal(byContent.format, 'fasta');
  assert.equal(byContent.formatSource, 'content');
});

test('statistics: sequences, residues and alphabet', () => {
  const r = fa('>a\nACGT\nAC\n>b\nNNNN\n');
  assert.deepEqual(r.stats, { sequences: 2, residues: 10, alphabet: 'nucleotide' });
  assert.equal(fa('>p\nMKVLAAGIVGLLLAQWPSEF\n').stats['alphabet'], 'protein');
});

test('soft-masked lowercase, N runs, gaps and a terminal stop are not reported', () => {
  assert.deepEqual(summary(fa('>chr1\nACGTacgtnnnnNNNNNNNNNNNNacgtACGT\n>aln\nAC--GT--ACGTRYKMSWBDHVN\n')), []);
  assert.deepEqual(summary(fa('>p1\nMKVLAAGIVGLLLAQWPSEFQDIRHMNYBZXUOJ*\n>p2\nMKV--LAAGIVGLLLAQWPSEFQDIRHMNY*\n')), []);
});

test('columns point at the offending characters', () => {
  const text = '>s1 demo\nACGTACGTACGTACGTACGTACGTACGTACGTAEGTACGT\n';
  const d = fa(text).diagnostics.find((x) => x.code === 'FA013')!;
  assert.equal(d.line, 2);
  assert.equal(text.split('\n')[1]!.slice(d.column - 1, d.endColumn - 1), 'E');
  const dup = fa('>id1 x\nACGT\n>id1 y\nACGT\n').diagnostics.find((x) => x.code === 'FA008')!;
  assert.deepEqual([dup.line, dup.column, dup.endColumn], [3, 2, 5]);
  assert.deepEqual(dup.notes, ['first used on line 1']);
});

test('blank lines: inside a record is an error, between records is not', () => {
  const inside = fa('>a\nACGT\n\nACGT\n>b\nACGT\n');
  assert.deepEqual(inside.diagnostics.map((d) => [d.code, d.severity, d.line]), [['FA005', 'error', 3]]);
  const between = fa('\n>a\nACGT\n\n\n>b\nACGT\n');
  assert.deepEqual(between.diagnostics.map((d) => [d.code, d.severity, d.line]), [['FA006', 'info', 1], ['FA006', 'info', 4]]);
  assert.equal(fa('>a\nACGT\n\n>b\nACGT\n', { profile: 'strict' }).diagnostics[0]!.severity, 'warning');
  // A line of spaces is a blank line, not sequence with whitespace.
  assert.deepEqual(codes(fa('>a\nACGT\n   \nACGT\n')), ['FA005']);
  assert.deepEqual(codes(fa('>a\nACGT\n \t\n>b\nACGT\n')), ['FA006']);
  // Blank lines at the very end belong to the generic rule.
  assert.deepEqual(codes(fa('>a\nACGT\n\n\n')), ['TXT013']);
});

test('line lengths follow what samtools faidx accepts', () => {
  assert.deepEqual(codes(fa('>a\nACGTACGT\nACGTACGT\nACG\n>b\nACGT\nAC\n>c\nA\n')), []);
  const short = fa('>a\nACGTACGT\nACG\nACGTACGT\nACGTACGT\n');
  assert.deepEqual(short.diagnostics.map((d) => [d.code, d.line]), [['FA007', 3]]);
  const long = fa('>a\nACGT\nACGTACGT\n');
  assert.deepEqual(long.diagnostics.map((d) => [d.code, d.line, d.column, d.endColumn]), [['FA007', 3, 5, 9]]);
  // One report per record, however ragged it is.
  assert.equal(fa('>a\nACGTACGT\nACG\nACGTA\nAC\nACGTACGTACGT\n').byRule['FA007']!.count, 1);
});

test('a numbered listing gives one diagnostic per line, not one per character', () => {
  const r = fa('>x\n        1 gatcctccat atacaacggt\n       21 ccgacatgag acagttaggt\n');
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line]), [['FA011', 2], ['FA011', 3]]);
  assert.match(r.diagnostics[0]!.message, /`1`/);
  assert.match(r.diagnostics[0]!.hint!, /sed/);
  assert.equal(r.stats['residues'], 40);
});

test('a missing line break before > is reported once and the swallowed header is not checked as sequence', () => {
  const r = fa('>a\nACGTACGT>b sample 2 (5 reads)\nACGT\n');
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.column]), [['FA012', 9]]);
  assert.ok(r.diagnostics[0]!.fix);
});

test('alphabet: a protein file is never checked against nucleotide codes', () => {
  // Rich in A, C, G, T but clearly protein.
  const protein = '>p1\nMACGTTGCAEELLKKAGCTTAGCAFFPQ\n>p2\nACGTACGTAEFLPQIZJO\n';
  assert.deepEqual(codes(fa(protein)), []);
  assert.equal(fa(protein).stats['alphabet'], 'protein');
});

test('alphabet: the first lines of a protein file do not trip the detector either', () => {
  // The very first line is all nucleotide letters (a poly-Ala/Gly stretch), the next is not.
  const r = fa('>p1\nAAAAAGGGGGAAAAAGGGGG\nMKVLEEFLPQIILKELPQFF\n');
  assert.deepEqual(codes(r), []);
});

test('alphabet: can be forced, and then letters of the other kind are errors', () => {
  const rna = '>r\nACGUACGUACGU\n';
  assert.deepEqual(codes(fa(rna)), []);
  const asDna = fa(rna, { formatOptions: { fasta: { alphabet: 'dna' } } });
  assert.deepEqual(asDna.diagnostics.map((d) => [d.code, d.column]), [['FA013', 4], ['FA013', 8], ['FA013', 12]]);
  assert.match(asDna.diagnostics[0]!.message, /declared as DNA/);
  assert.deepEqual(codes(fa('>d\nACGTACGT\n', { formatOptions: { fasta: { alphabet: 'rna' } } })), ['FA013', 'FA013']);
  assert.deepEqual(codes(fa('>d\nACGTEEEEFFFFLLLLACGT\n', { formatOptions: { fasta: { alphabet: 'protein' } } })), []);
  assert.equal(fa(rna, { formatOptions: { fasta: { alphabet: 'dna' } } }).stats['alphabet'], 'dna');
});

test('alphabet: protein records after nucleotide ones give one warning, not a flood of errors', () => {
  const text = '>contig\n' + (dna(60, 7) + '\n').repeat(100) + '>prot1\n' + 'MKVLAAGIVGLLLAQWPSEFQDIRHMNYEEFFLLPPQQ\n'.repeat(50) + '>prot2\nMEEPQSDPSVEPPLSQETFSDLWKLLPEN\n';
  const r = fa(text);
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.severity, d.line]), [['FA016', 'warning', 103]]);
  assert.equal(r.counts.error, 0);
  assert.equal(r.stats['alphabet'], 'mixed');
});

test('T and U in one record is reported once per record, at the letter that arrived second', () => {
  const r = fa('>a\nACGTACGT\nACGUACGU\nACGUACGU\n>b\nACGUACGU\n>c\nACGTACGT\n');
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line, d.column]), [['FA015', 3, 4]]);
});

test('duplicate identifiers: the description does not count, and memory is capped', () => {
  assert.deepEqual(codes(fa('>a first\nACGT\n>a second\nACGT\n>b\nACGT\n')), ['FA008']);
  assert.deepEqual(codes(fa('>a\nACGT\n>A\nACGT\n>a.1\nACGT\n')), []);
  // With room for three identifiers: a late repeat of an early one is found, a repeat among late ones is not, and the
  // file-level note says how far the check went.
  const text = '>s1\nA\n>s2\nA\n>s3\nA\n>s4\nA\n>s2\nA\n>s4\nA\n';
  const r = fa(text, { formatOptions: { fasta: { maxIds: 3 } } });
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.severity, d.line]), [['FA008', 'warning', 9], ['FA017', 'info', 0]]);
  assert.match(r.diagnostics[1]!.message, /first 3 records only \(6 records in total\)/);
  assert.deepEqual(codes(fa(text)), ['FA008', 'FA008']);
  // An identifier too long to remember does not break anything.
  const longId = 'x'.repeat(300);
  assert.deepEqual(codes(fa(`>${longId}\nACGT\n>${longId}\nACGT\n`)), []);
});

test('mechanical fixes repair the file, and nothing else changes', () => {
  const text = '> a first\nACGTACGT  \nACGTACGT>b second\nACGTAAAA\n';
  const r = fa(text);
  assert.deepEqual(codes(r), ['FA003', 'FA010', 'FA012']);
  const out = applyFixes(new TextEncoder().encode(text), r.diagnostics);
  assert.equal(out.applied, 3);
  const fixed = new TextDecoder().decode(out.output);
  assert.equal(fixed, '>a first\nACGTACGT\nACGTACGT\n>b second\nACGTAAAA\n');
  assert.deepEqual(summary(fa(fixed)), []);
});

test('a sequence line of several MiB is checked piece by piece with exact columns', () => {
  const n = 2_500_000;
  const bytes = new Uint8Array(5 + n + 1 + 5);
  bytes.set(new TextEncoder().encode('>big\n'), 0);
  bytes.fill(65, 5, 5 + n);          // A
  const bad1 = 1_200_000, bad2 = 2_400_000;
  bytes[5 + bad1] = 69;              // E, in the second piece
  bytes[5 + bad2] = 48;              // 0, in the third piece
  bytes[5 + n] = 10;
  bytes.set(new TextEncoder().encode('ACGT\n'), 5 + n + 1);
  const r = fa(bytes);
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.line, d.column, d.byteColumn]), [['FA013', 2, bad1 + 1, bad1 + 1], ['FA011', 2, bad2 + 1, bad2 + 1]]);
  assert.equal(r.lines, 3);
  assert.equal(r.stats['residues'], n - 1 + 4);
  assert.ok(r.diagnostics[0]!.excerpt!.text.includes('E'));
});

test('long lines: equal lengths are fine, CRLF endings are not blank lines, a longer line is uneven', () => {
  const w = (1 << 20) + 4096; // just over one piece
  const line = 'ACGT'.repeat(w / 4);
  const ok = fa(`>a\n${line}\n${line}\n${line.slice(0, 100)}\n`);
  assert.deepEqual(codes(ok), []);
  assert.equal(ok.stats['residues'], 2 * w + 100);
  // With CRLF the engine may deliver an empty final piece; it must not be read as a blank line inside the record.
  for (const width of [(1 << 20) - 1, 1 << 20, (1 << 20) + 1, 2 << 20]) {
    const l = 'A'.repeat(width);
    const crlf = fa(`>a\r\n${l}\r\n${l}\r\n`);
    assert.deepEqual(codes(crlf).filter((c) => c.startsWith('FA')), [], `width ${width}`);
    assert.equal(crlf.stats['residues'], 2 * width, `width ${width}`);
  }
  const uneven = fa(`>a\n${line}\n${line}ACGT\n`);
  assert.deepEqual(uneven.diagnostics.map((d) => [d.code, d.line]), [['FA007', 3]]);
});

test('a header longer than one piece is one header', () => {
  const r = fa(`>id ${'d'.repeat(3 << 20)}\nACGT\n>id2\nACGT\n`);
  assert.deepEqual(codes(r), []);
  assert.equal(r.stats['sequences'], 2);
});

test('results do not depend on how the input is cut into chunks', () => {
  const text = '\n>a desc\nACGTACGT\nACG\nACGTACGT\n\n> b\nACGT ACGT\n>a\n\nAC1GT\nACGT>c\n>d\n>e\nACGUT.\n# note\nEEEE\n';
  const whole = fa(text);
  assert.ok(whole.diagnostics.length >= 10);
  for (const size of [1, 2, 3, 5, 7, 16, 61]) {
    const r = chunked(text, size);
    assert.deepEqual(summary(r), summary(whole), `chunk size ${size}`);
    assert.deepEqual(r.stats, whole.stats, `chunk size ${size}`);
  }
});

test('memory: identifiers are the only thing kept per record, and long lines are not accumulated', () => {
  // 300 000 one-line records and a 40 MB single-line record, pushed in 1 MiB chunks.
  const linter = createLinter({ format: 'fasta' });
  const enc = new TextEncoder();
  const before = process.memoryUsage().heapUsed;
  let block = '';
  for (let i = 0; i < 300_000; i++) {
    block += `>read${i}\nACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT\n`;
    if (block.length > 1 << 20) { linter.push(enc.encode(block)); block = ''; }
  }
  linter.push(enc.encode(block + '>long\n'));
  const piece = new Uint8Array(1 << 20).fill(71);
  for (let i = 0; i < 40; i++) linter.push(piece);
  linter.push(enc.encode('\n'));
  const r = linter.end();
  assert.deepEqual(codes(r), []);
  assert.equal(r.stats['sequences'], 300_001);
  assert.equal(r.stats['residues'], 300_000 * 40 + (40 << 20));
  const grown = process.memoryUsage().heapUsed - before;
  // 52 MB of input in total; without a forced collection this is a coarse bound, not a measurement.
  assert.ok(grown < 256 * 1024 * 1024, `heap grew by ${(grown / 1048576).toFixed(0)} MB`);
});
