import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintText } from '../src/index.ts';
import type { LintResult } from '../src/index.ts';
import { GOOD_GTF_EXAMPLES, STRICT_GTF_EXAMPLES } from '../src/formats/gtf/rules.ts';

const row = (seq: string, feature: string, start: number, end: number, strand: string, attrs: string) =>
  `${seq}\ttest\t${feature}\t${start}\t${end}\t.\t${strand}\t${feature === 'CDS' || feature.endsWith('_codon') ? '0' : '.'}\t${attrs}`;
const ids = (g: string, t: string) => `gene_id "${g}"; transcript_id "${t}";`;
const lint = (lines: string[] | string, profile: 'default' | 'strict' = 'default') => lintText(typeof lines === 'string' ? lines : lines.join('\n') + '\n', { filename: 'a.gtf', profile, maxPerRule: 0 });
const codes = (r: LintResult) => r.diagnostics.map((d) => `${d.code}@${d.line}`);
const slice = (text: string, d: { line: number; column: number; endColumn: number }) => text.split('\n')[d.line - 1]!.slice(d.column - 1, d.endColumn - 1);

test('valid GTF examples produce no diagnostics', () => {
  for (const text of GOOD_GTF_EXAMPLES) {
    const r = lint(text);
    assert.deepEqual(r.diagnostics.map((d) => `${d.code}@${d.line}:${d.column} ${d.message}`), []);
    assert.equal(r.format, 'gtf');
  }
  for (const text of STRICT_GTF_EXAMPLES) assert.deepEqual(codes(lint(text, 'strict')), []);
});

test('default follows Ensembl/GENCODE practice, strict follows GTF 2.2', () => {
  const lines = [
    '#!genome-build GRCh38.p14',
    row('1', 'gene', 1, 90, '+', 'gene_id "G1"; gene_version "3"; gene_name "ABC";'),
    row('1', 'transcript', 1, 90, '+', 'gene_id "G1"; gene_version "3"; transcript_id "T1";'),
    row('1', 'exon', 1, 90, '+', 'gene_id "G1"; gene_version "3"; transcript_id "T1"; exon_number "1";'),
    row('1', 'Selenocysteine', 40, 42, '+', 'gene_id "G1"; gene_version "3"; transcript_id "T1";'),
    row('1', 'UTR', 1, 9, '+', 'gene_id "G1"; transcript_id "T1"; level 2; tag "basic"; tag "CCDS";'),
  ];
  assert.deepEqual(codes(lint(lines)), []);
  const strict = lint(lines, 'strict');
  const of = (code: string) => strict.diagnostics.filter((d) => d.code === code).map((d) => d.line);
  assert.deepEqual(of('GTF012'), [2, 3, 5, 6]);        // feature types outside GTF 2.2: warnings
  assert.deepEqual(of('GTF110'), [2]);                 // the gene line has no transcript_id
  assert.deepEqual(of('GTF111'), [3, 4, 5]);           // gene_version sits between the two mandatory attributes
  assert.equal(strict.diagnostics.find((d) => d.code === 'GTF012')!.severity, 'warning');
  // The GTF 2.2 way of saying "no gene, no transcript": both attributes present and empty.
  assert.deepEqual(lint([row('1', 'exon', 1, 9, '+', ids('G1', 'T1')), row('1', 'inter', 20, 30, '+', ids('', ''))], 'strict').counts.error, 0);
});

test('each attribute mistake gets its own diagnosis, pointing at the place', () => {
  const cases: [string, string, string, RegExp][] = [
    ['gene_id G1; transcript_id "T1";', 'GTF106', 'G1', /`gene_id "G1";`/],
    ['gene_id "G1" transcript_id "T1";', 'GTF103', '" t', /semicolon/],
    ['gene_id "G1"; transcript_id "T1"', 'GTF104', '"', /add `;`/],
    ['gene_id "G1"; transcript_id "T1;', 'GTF105', '"', /closing/],
    ['gene_id=G1;transcript_id=T1', 'GTF101', 'gene_id=G1', /--type gff3/],
    ['ID=exon1;Parent=T1', 'GTF101', 'ID=exon1', /gff3/],
    ['gene_id "G1"; transcript_id;', 'GTF102', 'transcript_id', /transcript_id "\.\.\."/],
    ['gene_id "G"1"; transcript_id "T1";', 'GTF103', '"1', /contain a double quote/],
  ];
  for (const [attrs, code, span, hint] of cases) {
    const text = row('1', 'exon', 1, 9, '+', attrs) + '\n';
    const r = lintText(text, { format: 'gtf', maxPerRule: 0 }); // by name, `a.gtf` with GFF3 attributes is detected as GFF3
    assert.deepEqual(codes(r), [`${code}@1`], attrs);
    assert.equal(slice(text, r.diagnostics[0]!), span, attrs);
    assert.match(r.diagnostics[0]!.hint!, hint, attrs);
  }
});

test('quoted values may contain semicolons, hashes and spaces', () => {
  const r = lint([
    '#gtf-version 2.2',
    row('MT1', 'CDS', 1, 9, '+', 'gene_id "orf1ab"; transcript_id "t1"; note "pp1ab; translated by -1 ribosomal frameshift"; product "x #1"; '),
    row('MT1', 'exon', 1, 9, '+', 'gene_id ""; transcript_id ""; exon_number 3; score 1.5e-3;'),
  ]);
  assert.deepEqual(codes(r), []);
  assert.equal(r.stats.transcripts, 1);
});

test('missing identifiers: gene_id everywhere, transcript_id on transcript features', () => {
  const r = lint([
    row('1', 'gene', 1, 9, '+', 'gene_id "G1";'),
    row('1', 'exon', 1, 9, '+', 'gene_id "G1"; exon_number 1;'),
    row('1', 'exon', 1, 9, '+', 'transcript_id "T1"; gene_name "x";'),
    row('1', 'exon', 1, 9, '+', '.'),
    row('1', 'aggregate_gene', 1, 9, '+', 'gene_id "G1";'),
  ]);
  assert.deepEqual(codes(r), ['GTF109@2', 'GTF108@3', 'GTF108@4', 'GTF109@4']);
});

test('comments, blank lines, and comments at the end of a feature line', () => {
  const text = ['# a comment', '', '##provider: GENCODE', row('1', 'exon', 1, 9, '+', ids('G1', 'T1') + ' # first exon'), row('1', 'exon', 20, 29, '+', ids('G1', 'T1')) + '\t# second'].join('\n') + '\n';
  const r = lint(text);
  assert.deepEqual(r.diagnostics.map((d) => `${d.code}@${d.line} ${d.severity}`), ['GTF010@4 warning', 'GTF010@5 warning']);
  assert.equal(slice(text, r.diagnostics[0]!), '# first exon');
  assert.deepEqual(codes(lint(text, 'strict')), []); // GTF 2.2 allows them
  assert.equal(r.stats.features, 2);
});

test('a transcript on two sequences or two strands is reported where it changes', () => {
  const lines = [
    row('chrX', 'exon', 1, 9, '+', ids('G1', 'T1')),
    row('chrX', 'exon', 20, 29, '+', ids('G1', 'T1')),
    row('chrX', 'exon', 1, 9, '-', ids('G2', 'T2')),
    row('chrY', 'exon', 1, 9, '+', ids('G1', 'T1')),
    row('chrY', 'exon', 20, 29, '+', ids('G1', 'T1')),
    row('chrX', 'exon', 40, 49, '+', ids('G2', 'T2')),
    row('chrX', 'exon', 60, 69, '.', ids('G2', 'T2')),
    row('chrX', 'exon', 80, 89, '+', ids('G2', 'T2')),
  ];
  const text = lines.join('\n') + '\n';
  const r = lint(text);
  assert.deepEqual(codes(r), ['GTF201@4', 'GTF202@6']);
  assert.equal(slice(text, r.diagnostics[0]!), 'chrY');
  assert.match(r.diagnostics[0]!.message, /`T1`.*`chrX`/);
  assert.deepEqual(r.diagnostics[0]!.notes, ['the transcript first appears on line 1']);
  assert.equal(slice(text, r.diagnostics[1]!), '+');
  // A strand of `.` says nothing either way.
  assert.deepEqual(codes(lint([row('1', 'transcript', 1, 99, '.', ids('G', 'T')), row('1', 'exon', 1, 9, '+', ids('G', 'T')), row('1', 'exon', 20, 29, '+', ids('G', 'T'))])), []);
});

test('stop codon inside the CDS: either order, both strands, but not for overlapping genes', () => {
  const plus = [row('1', 'CDS', 100, 201, '+', ids('G', 'T')), row('1', 'stop_codon', 199, 201, '+', ids('G', 'T'))];
  assert.deepEqual(codes(lint(plus)), ['GTF203@2']);
  assert.deepEqual(codes(lint([...plus].reverse())), ['GTF203@2']);
  assert.equal(lint(plus, 'strict').diagnostics.find((d) => d.code === 'GTF203')!.severity, 'error');
  const minus = [row('1', 'stop_codon', 100, 102, '-', ids('G', 'T')), row('1', 'CDS', 100, 201, '-', ids('G', 'T'))];
  assert.deepEqual(codes(lint(minus)), ['GTF203@2']);
  // The GTF convention: the stop codon follows the CDS.
  assert.deepEqual(codes(lint([row('1', 'CDS', 100, 198, '+', ids('G', 'T')), row('1', 'stop_codon', 199, 201, '+', ids('G', 'T'))])), []);
  // Two overlapping viral ORFs under one transcript_id: the stop of the first lies inside the second CDS.
  assert.deepEqual(codes(lint([row('v', 'CDS', 100, 198, '+', ids('A', 'T')), row('v', 'stop_codon', 199, 201, '+', ids('A', 'T')), row('v', 'CDS', 198, 300, '+', ids('B', 'T'))])), []);
});

test('frames: CDS by default, codons too in strict mode', () => {
  const lines = ['1\tt\tCDS\t1\t9\t.\t+\t.\t' + ids('G', 'T'), '1\tt\tstart_codon\t1\t3\t.\t+\t.\t' + ids('G', 'T'), '1\tt\texon\t1\t9\t.\t+\t.\t' + ids('G', 'T')];
  assert.deepEqual(lint(lines).diagnostics.map((d) => `${d.code}@${d.line} ${d.severity}`), ['GTF009@1 warning']);
  assert.deepEqual(lint(lines, 'strict').diagnostics.map((d) => `${d.code}@${d.line} ${d.severity}`), ['GTF009@1 error', 'GTF009@2 error']);
});

test('many transcripts: the table grows without losing earlier ones', () => {
  const n = 20_000;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(row('chr1', 'exon', i + 1, i + 9, '+', ids(`G${i}`, `T${i}`)));
  lines.push(row('chr2', 'exon', 5, 9, '+', ids('G3', 'T3')));
  lines.push(row('chr1', 'exon', 5, 9, '-', ids('G19999', 'T19999')));
  const r = lint(lines);
  assert.deepEqual(codes(r), [`GTF201@${n + 1}`, `GTF202@${n + 2}`]);
  assert.equal(r.stats.transcripts, n);
});
