import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintText } from '../src/index.ts';
import type { LintResult } from '../src/index.ts';
import { GOOD_GFF3_EXAMPLES } from '../src/formats/gff3/rules.ts';
import { IdTable, sniffGff3, sniffGtf } from '../src/formats/gff3/shared.ts';

const gff = (lines: string[], header = true) => (header ? '##gff-version 3\n' : '') + lines.map((l) => l.replace(/ +\| +| *→ */g, '\t')).join('\n') + '\n';
/** `seqid | type | start | end | attributes`, with the other columns filled in. */
const feat = (seqid: string, type: string, start: number, end: number, attrs: string) => `${seqid}\ttest\t${type}\t${start}\t${end}\t.\t+\t${type === 'CDS' ? '0' : '.'}\t${attrs}`;
const lint = (text: string, profile: 'default' | 'strict' = 'default', filename = 'a.gff3') => lintText(text, { filename, profile, maxPerRule: 0 });
const codes = (r: LintResult) => r.diagnostics.map((d) => `${d.code}@${d.line}`);
const slice = (text: string, d: { line: number; column: number; endColumn: number }) => text.split('\n')[d.line - 1]!.slice(d.column - 1, d.endColumn - 1);

test('valid GFF3 examples produce no diagnostics, in both profiles', () => {
  for (const text of GOOD_GFF3_EXAMPLES) {
    for (const profile of ['default', 'strict'] as const) {
      const r = lint(text, profile);
      assert.deepEqual(r.diagnostics.map((d) => `${d.code}@${d.line}:${d.column} ${d.message}`), [], profile);
      assert.equal(r.format, 'gff3');
    }
  }
});

test('diagnostics point at the offending text', () => {
  const text = gff(['chr1 | src | gene | 1,000 | 2000 | . | forward | . | ID=g1;Parent=', 'chr1 | src | CDS | 10 | 20 | 0.5 | + | 4 | Parent=g1;Target=EST1 5']);
  const r = lint(text);
  const by = (code: string) => r.diagnostics.find((d) => d.code === code)!;
  assert.equal(slice(text, by('GFF106')), '1,000');
  assert.match(by('GFF106').hint!, /`1000`/);
  assert.equal(slice(text, by('GFF109')), 'forward');
  assert.match(by('GFF109').hint!, /`\+`/);
  assert.equal(slice(text, by('GFF203')), 'Parent=');
  assert.equal(slice(text, by('GFF110')), '4');
  assert.equal(slice(text, by('GFF212')), 'EST1 5');
});

test('a structural problem on a line suppresses the checks that depend on it', () => {
  const r = lint(gff(['chr1 src gene x y . + . id=g1', 'chr1 | src | gene | 5 | 9 | . | + | . | ID=g1']));
  assert.deepEqual(codes(r), ['GFF101@2']);
  assert.match(r.diagnostics[0]!.hint!, /spaces/);
});

test('forward Parent references are legal; unresolved ones are reported at the end, on the referring line', () => {
  const ok = lint(gff([feat('chr1', 'exon', 1, 5, 'Parent=tx1'), feat('chr1', 'exon', 8, 9, 'Parent=tx1'), feat('chr1', 'mRNA', 1, 9, 'ID=tx1;Parent=g1'), feat('chr1', 'gene', 1, 9, 'ID=g1')]));
  assert.deepEqual(codes(ok), []);
  const bad = lint(gff([feat('chr1', 'exon', 1, 5, 'Parent=tx1'), feat('chr1', 'exon', 8, 9, 'Parent=tx1'), feat('chr1', 'mRNA', 1, 9, 'ID=tx2')]));
  assert.deepEqual(codes(bad), ['GFF303@2']);
  assert.match(bad.diagnostics[0]!.message, /`tx1`/);
  assert.deepEqual(bad.diagnostics[0]!.notes, ['2 features refer to it']);
});

test('a ### line resolves forward references and closes the features above it', () => {
  // The parent arrives after the ###: too late for the child above it.
  const late = lint(gff([feat('chr1', 'exon', 1, 5, 'Parent=tx1'), '###', feat('chr1', 'mRNA', 1, 9, 'ID=tx1')]));
  assert.deepEqual(codes(late), ['GFF303@2']);
  assert.match(late.diagnostics[0]!.message, /in this block/);
  // The child arrives after the ### that closed its parent: a warning by default, an error in strict mode.
  const text = gff([feat('chr1', 'mRNA', 1, 9, 'ID=tx1'), '###', feat('chr1', 'exon', 1, 5, 'Parent=tx1')]);
  const across = lint(text);
  assert.deepEqual(codes(across), ['GFF306@4']);
  assert.equal(across.diagnostics[0]!.severity, 'warning');
  assert.equal(slice(text, across.diagnostics[0]!), 'tx1');
  assert.equal(lint(text, 'strict').diagnostics[0]!.severity, 'error');
  // Blocks that are complete in themselves are fine, and `####` is a comment, not a terminator.
  const fine = lint(gff([feat('chr1', 'gene', 1, 9, 'ID=g1'), feat('chr1', 'mRNA', 1, 9, 'ID=tx1;Parent=g1'), '###', feat('chr1', 'gene', 20, 30, 'ID=g2'), '#### not a terminator', feat('chr1', 'mRNA', 20, 30, 'ID=tx2;Parent=g2')]));
  assert.deepEqual(codes(fine), []);
});

test('lines that share an ID are one discontinuous feature only if type and sequence agree', () => {
  const parent = feat('chr1', 'mRNA', 1, 90, 'ID=tx1');
  assert.deepEqual(codes(lint(gff([parent, feat('chr1', 'CDS', 1, 10, 'ID=cds1;Parent=tx1'), feat('chr1', 'CDS', 20, 30, 'ID=cds1;Parent=tx1'), feat('chr1', 'CDS', 40, 50, 'ID=cds1;Parent=tx1')]))), []);
  const type = lint(gff([parent, feat('chr1', 'CDS', 1, 10, 'ID=x;Parent=tx1'), feat('chr1', 'exon', 1, 10, 'ID=x;Parent=tx1')]));
  assert.deepEqual(codes(type), ['GFF301@4']);
  assert.match(type.diagnostics[0]!.message, /`CDS` feature/);
  assert.deepEqual(type.diagnostics[0]!.notes, ['first used on line 3']);
  const seq = lint(gff([feat('chr1', 'gene', 1, 10, 'ID=g1'), feat('chr2', 'gene', 1, 10, 'ID=g1')]));
  assert.deepEqual(codes(seq), ['GFF301@3']);
  assert.match(seq.diagnostics[0]!.message, /`chr1`/);
  const twice = lint(gff([feat('chr1', 'gene', 1, 10, 'ID=g1'), feat('chr1', 'gene', 1, 10, 'ID=g1')]));
  assert.deepEqual(twice.diagnostics.map((d) => `${d.code} ${d.severity}`), ['GFF302 warning']);
});

test('Parent on another sequence is found whichever of the two comes first', () => {
  const after = lint(gff([feat('chr1', 'mRNA', 1, 9, 'ID=tx1'), feat('chr2', 'exon', 1, 5, 'Parent=tx1')]));
  assert.deepEqual(codes(after), ['GFF304@3']);
  const before = lint(gff([feat('chr2', 'exon', 1, 5, 'Parent=tx1'), feat('chr1', 'mRNA', 1, 9, 'ID=tx1')]));
  assert.deepEqual(codes(before), ['GFF304@2']);
  assert.match(before.diagnostics[0]!.message, /`chr2`.*`tx1`.*`chr1`/);
});

test('cycles are found through forward references and second parents, and only once', () => {
  const three = lint(gff([feat('chr1', 'a', 1, 9, 'ID=a;Parent=b'), feat('chr1', 'b', 1, 9, 'ID=b;Parent=c'), feat('chr1', 'c', 1, 9, 'ID=c;Parent=a')]));
  assert.deepEqual(three.diagnostics.map((d) => d.code), ['GFF305']);
  assert.match(three.diagnostics[0]!.message, /lines 2, 3, 4/);
  const second = lint(gff([feat('chr1', 'gene', 1, 9, 'ID=g1'), feat('chr1', 'a', 1, 9, 'ID=a;Parent=g1,b'), feat('chr1', 'b', 1, 9, 'ID=b;Parent=g1,a')]));
  assert.deepEqual(second.diagnostics.map((d) => d.code), ['GFF305']);
  // A diamond (two paths to the same ancestor) is not a cycle.
  const diamond = lint(gff([feat('chr1', 'gene', 1, 9, 'ID=g1'), feat('chr1', 'mRNA', 1, 9, 'ID=t1;Parent=g1'), feat('chr1', 'mRNA', 1, 9, 'ID=t2;Parent=g1'), feat('chr1', 'exon', 1, 9, 'ID=e1;Parent=t1,t2')]));
  assert.deepEqual(codes(diamond), []);
});

test('after ##FASTA no feature rule applies, and an initial > starts the section too', () => {
  const seq = ['>chr1 some description', 'ACGTNNNN\tACGT', 'chr1 is not a feature', '', 'acgtacgt', '>p1', 'MKV*'];
  for (const directive of [['##FASTA'], []]) {
    const r = lint(gff([feat('chr1', 'gene', 1, 9, 'ID=g1'), ...directive, ...seq]));
    assert.deepEqual(codes(r), []);
    assert.equal(r.stats.features, 1);
  }
  // Parents are resolved before the sequence starts.
  const orphan = lint(gff([feat('chr1', 'exon', 1, 9, 'Parent=tx1'), '##FASTA', '>chr1', 'ACGT']));
  assert.deepEqual(codes(orphan), ['GFF303@2']);
  // Features after the sequences are lost by parsers.
  const tail = lint(gff([feat('chr1', 'gene', 1, 9, 'ID=g1'), '##FASTA', '>chr1', 'ACGT', '##FASTA', feat('chr1', 'gene', 1, 9, 'ID=g2')]));
  assert.deepEqual(codes(tail), ['GFF008@6', 'GFF008@7']);
});

test('##sequence-region: runs of spaces, bounds, and the circular exception', () => {
  const region = '##sequence-region   plasmid 1\t5000';
  assert.deepEqual(codes(lint(gff([region, feat('plasmid', 'gene', 4000, 5000, 'ID=g1')]))), []);
  const out = lint(gff([region, feat('plasmid', 'gene', 4000, 5600, 'ID=g1')]));
  assert.deepEqual(codes(out), ['GFF007@3']);
  assert.equal(out.diagnostics[0]!.severity, 'warning');
  const circular = [region, feat('plasmid', 'region', 1, 5000, 'ID=p;Is_circular=true'), feat('plasmid', 'gene', 4000, 5600, 'ID=g1')];
  assert.deepEqual(codes(lint(gff(circular), 'strict')), []);
  // More than one full turn is still out of range.
  assert.deepEqual(codes(lint(gff([...circular, feat('plasmid', 'gene', 4000, 10100, 'ID=g2')]))), ['GFF007@5']);
});

test('lower-case id= and parent= are reported unless the real tag is present', () => {
  const text = gff([feat('chr1', 'gene', 1, 9, 'id=g1'), feat('chr1', 'mRNA', 1, 9, 'ID=t1;parent=g1'), feat('chr1', 'mRNA', 1, 9, 'ID=t2;id=t2;note=fine')]);
  const r = lint(text);
  assert.deepEqual(codes(r), ['GFF205@2', 'GFF205@3']);
  assert.equal(slice(text, r.diagnostics[0]!), 'id');
  assert.equal(slice(text, r.diagnostics[1]!), 'parent');
  assert.equal(r.counts.error, 0);
});

test('GTF-style attributes in a file checked as GFF3 are named as such, once per line', () => {
  const text = gff(['chr1 | src | exon | 1 | 9 | . | + | . | gene_id "g1"; transcript_id "t1";', 'chr1 | src | exon | 1 | 9 | . | + | . | gene_id "g1"'], false);
  const r = lintText(text, { format: 'gff3', maxPerRule: 0 });
  assert.deepEqual(codes(r), ['GFF001@1', 'GFF202@1', 'GFF202@2']);
  assert.match(r.diagnostics[1]!.hint!, /--type gtf/);
});

test('quotes do not protect semicolons, and the damage is reported once', () => {
  const r = lint(gff([feat('chr1', 'CDS', 1, 9, 'ID=c1;note="pp1ab; translated by -1 frameshift; E=protein";product="x"')]));
  assert.deepEqual(r.diagnostics.map((d) => `${d.code} ${d.severity}`), ['GFF210 warning', 'GFF209 info']);
});

test('the version pragma: missing, late, repeated, wrong', () => {
  const g = feat('chr1', 'gene', 1, 9, 'ID=g1');
  assert.deepEqual(lint(g + '\n').diagnostics.map((d) => `${d.code} ${d.severity}`), ['GFF001 warning']);
  assert.deepEqual(lint(g + '\n', 'strict').diagnostics.map((d) => `${d.code} ${d.severity}`), ['GFF001 error']);
  assert.deepEqual(codes(lint('# comment\n\n##gff-version 3\n' + g + '\n')), []);
  assert.deepEqual(codes(lint('# comment\n##gff-version 3\n' + g + '\n', 'strict')), ['GFF003@2']);
  assert.deepEqual(codes(lint('##gff-version\t3.1.26\n' + g + '\n', 'strict')), []);
  assert.deepEqual(codes(lint('##gff-version 3\n' + g + '\n##gff-version 3\n')), ['GFF004@3']);
  assert.deepEqual(codes(lint('##gff-version 2.5\n' + g + '\n')), ['GFF002@1']);
});

test('detection: .gff holding GTF is checked as GTF, .gtf holding GFF3 as GFF3', () => {
  const gtfBody = 'X\tdexseq\texonic_part\t1\t9\t.\t+\t.\tgene_id "ENSG1"\nX\tdexseq\texonic_part\t1\t9\t.\t+\t.\tgene_id "ENSG1"; transcripts "t1+t2"; exonic_part_number "001"\n';
  const gff3Body = '##gff-version 3\nchr1\tsrc\tgene\t1\t9\t.\t+\t.\tID=g1;Name=x\n';
  const a = lintText(gtfBody, { filename: 'flattened.gff' });
  assert.equal(a.format, 'gtf');
  assert.equal(a.formatSource, 'content');
  assert.ok(a.diagnostics.some((d) => /\.gff.*content is GTF/.test(d.message)));
  const b = lintText(gff3Body, { filename: 'genes.gtf' });
  assert.equal(b.format, 'gff3');
  assert.equal(b.formatSource, 'content');
  for (const name of ['genes.gff', 'genes.gff3', 'genes.gff3.gz']) {
    const c = lintText(gff3Body, { filename: name });
    assert.equal(c.format, 'gff3');
    assert.equal(c.formatSource, 'extension');
    assert.deepEqual(c.diagnostics, []);
  }
  // No pragma, GFF3 attributes: still GFF3. No attributes at all: the extension decides.
  assert.equal(lintText(gff3Body.split('\n').slice(1).join('\n'), { filename: 'x.gff' }).format, 'gff3');
  assert.equal(lintText('chr1\tsrc\tgene\t1\t9\t.\t+\t.\t.\n', { filename: 'x.gff' }).format, 'gff3');
  assert.equal(lintText('chr1\tsrc\tgene\t1\t9\t.\t+\t.\t.\n', { filename: 'x.gtf' }).format, 'gtf');
  // Without a helpful extension the content decides.
  assert.equal(lintText(gff3Body, { filename: 'annotation.txt' }).format, 'gff3');
  assert.equal(lintText(gtfBody, { filename: 'annotation.txt' }).format, 'gtf');
});

test('sniff scores keep the two formats apart', () => {
  const gtfLines = ['#!genome-build GRCh38', '1\thavana\tgene\t1\t9\t.\t+\t.\tgene_id "g"; gene_version "1";', '1\thavana\texon\t1\t9\t.\t+\t.\tgene_id "g"; transcript_id "t"; exon_number 1;'];
  const gffLines = ['##gff-version 3', '1\thavana\tgene\t1\t9\t.\t+\t.\tID=gene:g;biotype=protein_coding'];
  assert.ok(sniffGtf(gtfLines) >= 0.9 && sniffGff3(gtfLines) < 0.3);
  assert.ok(sniffGff3(gffLines) >= 0.9 && sniffGtf(gffLines) < 0.3);
  assert.ok(sniffGff3(gffLines.slice(1)) >= 0.9 && sniffGtf(gffLines.slice(1)) < 0.3);
  for (const other of [['##fileformat=VCFv4.3', '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO', '1\t100\t.\tA\tT\t.\t.\t.'], ['>seq1', 'ACGT'], ['chr1\t0\t100\tname\t0\t+'], ['@SQ\tSN:chr1\tLN:100']]) {
    assert.equal(sniffGff3(other), 0);
    assert.equal(sniffGtf(other), 0);
  }
});

test('IdTable: entry numbers survive growth, and distinct identifiers stay distinct', () => {
  const t = new IdTable(1, 16);
  const n = 50_000;
  const entries: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = t.intern(`prefix id${i} suffix`, 7, 7 + `id${i}`.length);
    assert.equal(t.added, true);
    t.set(0, e, i + 1);
    entries.push(e);
  }
  assert.equal(t.size, n);
  for (let i = 0; i < n; i += 7) {
    assert.equal(t.find(`id${i}`), entries[i]);
    assert.equal(t.intern(`id${i}`), entries[i]);
    assert.equal(t.added, false);
    assert.equal(t.get(0, entries[i]!), i + 1);
  }
  assert.equal(t.find('id-absent'), -1);
  assert.equal(t.size, n);
});

test('many forward references stay resolvable while the ID table grows', () => {
  // Children first, parents last, in reverse: every reference is outstanding while the table grows to 60,000
  // entries (several chunks, and the bucket array is rebuilt four times).
  const n = 30_000;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(feat('chr1', 'exon', i + 1, i + 5, `ID=e${i};Parent=t${i}`));
  for (let i = n - 1; i >= 0; i--) lines.push(feat('chr1', 'mRNA', i + 1, i + 5, `ID=t${i}`));
  assert.deepEqual(codes(lint(gff(lines))), []);
  // Remove one parent and rename another so that it lands on a different sequence.
  const missing = lines.filter((l) => !l.endsWith('\tID=t12345'));
  const r = lint(gff(missing));
  assert.deepEqual(codes(r), ['GFF303@12347']);
  assert.match(r.diagnostics[0]!.message, /`t12345`/);
  const moved = lines.map((l) => (l.endsWith('\tID=t777') ? l.replace('chr1', 'chr2') : l));
  assert.deepEqual(codes(lint(gff(moved))), ['GFF304@779']);
});
