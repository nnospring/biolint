import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFixes, createLinter, lintText } from '../src/index.ts';
import type { LintResult, Profile } from '../src/index.ts';
import { GOOD_SAM_EXAMPLES } from '../src/formats/sam/rules.ts';

const HEAD = '@HD\tVN:1.6\tSO:unsorted\n@SQ\tSN:chr1\tLN:1000\n@SQ\tSN:chr2\tLN:500\n';
/** One alignment line; override fields by name, add optional fields with `aux`. */
function rec(over: Partial<Record<'qname' | 'flag' | 'rname' | 'pos' | 'mapq' | 'cigar' | 'rnext' | 'pnext' | 'tlen' | 'seq' | 'qual' | 'aux', string>> = {}): string {
  const f = { qname: 'r1', flag: '0', rname: 'chr1', pos: '10', mapq: '30', cigar: '5M', rnext: '*', pnext: '0', tlen: '0', seq: 'ACGTA', qual: 'IIIII', ...over };
  return [f.qname, f.flag, f.rname, f.pos, f.mapq, f.cigar, f.rnext, f.pnext, f.tlen, f.seq, f.qual].join('\t') + (over.aux !== undefined ? '\t' + over.aux : '') + '\n';
}
const lint = (text: string, profile: Profile = 'default') => lintText(text, { filename: 't.sam', profile, maxPerRule: 0 });
const codes = (r: LintResult) => r.diagnostics.map((d) => d.code);
const show = (r: LintResult) => r.diagnostics.map((d) => `${d.code}@${d.line}:${d.column} ${d.message}`);
const severity = (r: LintResult, code: string) => r.diagnostics.find((d) => d.code === code)?.severity;

test('valid SAM examples produce no diagnostics, in both profiles', () => {
  for (const text of GOOD_SAM_EXAMPLES) {
    for (const profile of ['default', 'strict'] as const) {
      const r = lint(text, profile);
      assert.deepEqual(show(r), [], profile);
      assert.equal(r.format, 'sam');
    }
  }
});

test('summary numbers and format detection from content', () => {
  const r = lintText(GOOD_SAM_EXAMPLES[1]!, { filename: 'alignments.txt' });
  assert.equal(r.format, 'sam');
  assert.equal(r.formatSource, 'content');
  assert.equal(r.stats.records, 2);
  assert.equal(r.stats.version, 'SAM 1.6');
  // A file without a header is recognised from its first alignment line.
  assert.equal(lintText(rec({ flag: '4', rname: '*', pos: '0', cigar: '*' }), { filename: 'reads.out' }).format, 'sam');
  // FASTQ also starts with `@`: it must not be taken for SAM.
  assert.notEqual(lintText('@read1\nACGT\n+\nIIII\n', { filename: 'reads.out' }).format, 'sam');
});

test('diagnostics point at the smallest wrong span', () => {
  const line = rec({ cigar: '2M1S2M', aux: 'NM:i:0\tXF:f:1.5x' });
  const r = lint(HEAD + line);
  const span = (code: string) => { const d = r.diagnostics.find((x) => x.code === code)!; return line.slice(d.column - 1, d.endColumn - 1); };
  assert.equal(span('SAM115'), '1S');
  assert.equal(span('SAM205'), '1.5x');
  assert.equal(r.diagnostics.find((d) => d.code === 'SAM115')!.line, 4);
  const flag = lint(HEAD + rec({ flag: '66' })).diagnostics.find((d) => d.code === 'SAM106')!;
  assert.match(flag.message, /0x2 proper pair \+ 0x40 first in template/);
  assert.match(flag.hint!, /67.*or 0/);
});

test('levels follow the profile: tolerated by samtools is a warning by default and an error in strict', () => {
  const cases: [string, string][] = [
    ['SAM103', HEAD + rec({ qname: 'a@b' })],
    ['SAM115', HEAD + rec({ cigar: '2M1H3M' })],
    ['SAM207', HEAD + rec({ aux: 'NM:i:1\tNM:i:1' })],
    ['SAM208', HEAD + rec({ aux: 'NM:Z:1' })],
    ['SAM206', HEAD + rec({ aux: 'XF:f:inf' })],
    ['SAM001', '@SQ\tSN:chr1\tLN:1000\n@HD\tVN:1.6\n' + rec()],
    ['SAM015', HEAD + '@RG\tID:a\n@RG\tID:a\n' + rec()],
  ];
  for (const [code, text] of cases) {
    assert.equal(severity(lint(text), code), 'warning', code);
    assert.equal(severity(lint(text, 'strict'), code), 'error', code);
  }
  // The header is optional in the specification, but samtools cannot read mapped records without @SQ lines.
  assert.equal(severity(lint(rec()), 'SAM109'), 'error');
  assert.equal(severity(lint(rec(), 'strict'), 'SAM109'), 'warning');
  // "No assumptions can be made" is never an error.
  assert.equal(severity(lint(HEAD + rec({ flag: '66' }), 'strict'), 'SAM106'), 'warning');
  assert.equal(lint(HEAD + rec({ flag: '4', cigar: '*', rname: '*', pos: '0', aux: 'XX:Z:x' }), 'strict').counts.error, 0);
});

test('one problem, one diagnostic: dependent checks are skipped', () => {
  // Too few fields: nothing else is said about the line.
  assert.deepEqual(codes(lint(HEAD + 'r1\t0\tchr1\t10\n')), ['SAM101']);
  // A malformed CIGAR is not also compared with SEQ.
  assert.deepEqual(codes(lint(HEAD + rec({ cigar: '5Q' }))), ['SAM114']);
  // An empty SEQ is not also compared with CIGAR and QUAL.
  assert.deepEqual(codes(lint(HEAD + rec({ seq: '' }))), ['SAM102']);
  // An unknown type letter is not also held against the predefined type of the tag.
  assert.deepEqual(codes(lint(HEAD + rec({ aux: 'NM:z:1' }))), ['SAM204']);
  // A space for a tab that hides LN is reported once, not also as a bad name and a missing tag.
  assert.deepEqual(codes(lint('@HD\tVN:1.6\n@SQ\tSN:chr1 LN:1000\n' + rec({ flag: '4', rname: '*', pos: '0', cigar: '*' }))), ['SAM005']);
});

test('CIGAR: clipping positions', () => {
  const ok = ['5M', '1S4M', '4M1S', '1H1S3M', '3M1S1H', '2H3S', '5S', '1H5M1H', '0H0S5M0S0H', '2M1D1I2M', '2M3N3M', '5=', '2X3=', '2M2P3M', '1H5S1H'];
  const bad = ['2M1S2M', '2M1H3M', '1S1H4M', '4M1H1S', '1S1S3M', '3M1S1S'];
  const seqFor = (cigar: string) => { let n = 0; for (const m of cigar.matchAll(/(\d+)([MIS=X])/g)) n += +m[1]!; return n ? 'A'.repeat(n) : '*'; };
  for (const c of ok) assert.deepEqual(show(lint(HEAD + rec({ cigar: c, seq: seqFor(c), qual: '*' }))), [], c);
  for (const c of bad) assert.deepEqual(codes(lint(HEAD + rec({ cigar: c, seq: seqFor(c), qual: '*' }))), ['SAM115'], c);
});

test('CIGAR: grammar and length against SEQ', () => {
  for (const c of ['M', '5', '5M2', 'M5', '5m', '5M 5M', '-5M', '5MM', '268435456M']) assert.deepEqual(codes(lint(HEAD + rec({ cigar: c, seq: '*', qual: '*' }))), ['SAM114'], c);
  assert.deepEqual(codes(lint(HEAD + rec({ cigar: '268435455N1M', seq: 'A', qual: 'I' }))).filter((c) => c === 'SAM114'), []);
  // H, D, N and P do not count towards the read length; SEQ `*` is never compared.
  assert.deepEqual(show(lint(HEAD + rec({ cigar: '3H2M10D1I2P2M4H' }))), []);
  assert.deepEqual(show(lint(HEAD + rec({ cigar: '99M', seq: '*', qual: '*' }))), []);
  const d = lint(HEAD + rec({ cigar: '4M2S' })).diagnostics[0]!;
  assert.equal(d.code, 'SAM116');
  assert.match(d.message, /describes 6 read bases but SEQ has 5/);
});

test('optional field values: what each type accepts', () => {
  const ok = ['XA:A:!', 'XA:A:~', 'XI:i:0', 'XI:i:-2147483648', 'XI:i:4294967295', 'XI:i:+5', 'XI:i:007', 'XF:f:1', 'XF:f:-.5', 'XF:f:+1.5e-10', 'XF:f:3.402823466E+38',
    'XZ:Z:', 'XZ:Z:a b:c', 'XH:H:', 'XH:H:00FF', 'XB:B:c', 'XB:B:c,-128,127', 'XB:B:C,0,255', 'XB:B:s,-32768,32767', 'XB:B:S,65535', 'XB:B:i,-2147483648', 'XB:B:I,4294967295', 'XB:B:f,1,-2.5,1e3'];
  for (const aux of ok) assert.deepEqual(show(lint(HEAD + rec({ aux }), 'strict')), [], aux);
  const invalid = ['XA:A:', 'XA:A:ab', 'XI:i:', 'XI:i:1.5', 'XI:i:abc', 'XI:i:-2147483649', 'XI:i:4294967296', 'XI:i:1e3', 'XF:f:', 'XF:f:abc', 'XF:f:1,5', 'XF:f:e', 'XH:H:F', 'XH:H:GG',
    'XB:B:', 'XB:B:d,1', 'XB:B:i1', 'XB:B:i,', 'XB:B:i,1,', 'XB:B:i,1,,2', 'XB:B:i,1.5', 'XB:B:i,x', 'XB:B:I,4294967296', 'XB:B:f,x'];
  for (const aux of invalid) assert.deepEqual(codes(lint(HEAD + rec({ aux }))), ['SAM205'], aux);
  const loose = ['XA:A: ', 'XF:f:5.', 'XF:f:nan', 'XF:f:-inf', 'XF:f:3.5e38', 'XZ:Z:café', 'XH:H:00ff', 'XB:B:c,128', 'XB:B:C,-1', 'XB:B:S,65536', 'XB:B:f,nan'];
  for (const aux of loose) {
    assert.deepEqual(codes(lint(HEAD + rec({ aux }))), ['SAM206'], aux);
    assert.equal(lint(HEAD + rec({ aux }), 'strict').counts.error, 1, aux);
  }
});

test('optional fields: structure, tags and types', () => {
  for (const aux of ['NM', 'NM:1', 'NM:i', 'N:i:1', 'NMM:i:1', 'NM=1', 'NM::1']) assert.deepEqual(codes(lint(HEAD + rec({ aux }))), ['SAM201'], aux);
  assert.deepEqual(codes(lint(HEAD + rec({ aux: 'NM:i:1\t\tAS:i:2' }))), ['SAM201']);
  assert.deepEqual(codes(lint(HEAD + rec({ aux: 'NM:i:1\t' }))), ['SAM202']);
  assert.deepEqual(codes(lint(HEAD + rec({ aux: '' }))), ['SAM202']);
  for (const aux of ['1A:i:1', 'A_:i:1', '_A:i:1']) assert.deepEqual(codes(lint(HEAD + rec({ aux }))), ['SAM203'], aux);
  for (const aux of ['XX:z:a', 'XX:c:1', 'XX:S:1', 'XX:F:1.5', 'XX:x:1']) assert.deepEqual(codes(lint(HEAD + rec({ aux }))), ['SAM204'], aux);
  for (const aux of ['XX:I:1', 'XX:d:1.5']) assert.deepEqual(codes(lint(HEAD + rec({ aux }))), ['SAM212'], aux);
  // Lower-case tags and X/Y/Z tags are free; predefined ones are held to their type, whatever the array element type.
  assert.deepEqual(show(lint(HEAD + rec({ aux: 'nm:Z:x\tXM:Z:x\tYS:i:1\tZZ:f:1\tML:B:C,1\tFZ:B:S,1\tTS:A:+' }), 'strict')), []);
  assert.deepEqual(codes(lint(HEAD + rec({ aux: 'MD:i:5\tAS:f:1.0\tSA:A:x\tML:Z:1' }))), ['SAM208', 'SAM208', 'SAM208', 'SAM208']);
});

test('duplicate tags are tracked per record, not across records', () => {
  const r = lint(HEAD + rec({ aux: 'NM:i:1\tAS:i:5' }) + rec({ aux: 'NM:i:1\tAS:i:5' }) + rec({ aux: 'AS:i:5\tNM:i:1\tAS:i:6' }));
  assert.deepEqual(show(r).map((s) => s.slice(0, 11)), ['SAM207@6:52']);
});

test('reference names: every occurrence is counted, with or without the name cache', () => {
  const text = HEAD + rec({ rname: 'chrX' }) + rec({ rname: 'chrX' }) + rec() + rec({ rname: 'chrX' }) + rec({ flag: '65', rnext: 'chrY', pnext: '5' }) + rec({ flag: '65', rnext: 'chrY', pnext: '5' });
  const r = lint(text);
  assert.equal(r.byRule.SAM108!.count, 5);
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'SAM108').map((d) => d.line), [4, 5, 7, 8, 9]);
  // `=` and `*` in RNEXT, and RNEXT spelled out like RNAME, need no lookup.
  assert.deepEqual(show(lint(HEAD + rec({ flag: '65', rnext: '=', pnext: '5' }) + rec({ flag: '65', rnext: 'chr1', pnext: '5' }) + rec({ flag: '65', rnext: 'chr2', pnext: '5' }))), []);
  // The hint recognises the usual cause.
  assert.match(lint(HEAD + rec({ rname: '1' })).diagnostics[0]!.hint!, /header declares `chr1`/);
  // An alternative name resolves to its reference, so position checks still apply.
  const alias = lint('@HD\tVN:1.6\n@SQ\tSN:MT\tLN:100\tAN:chrM\n' + rec({ rname: 'chrM', pos: '500' }));
  assert.deepEqual(codes(alias), ['SAM125', 'SAM112']);
});

test('read groups and programs: declared, undeclared, and absent from the header', () => {
  const rg = HEAD + '@RG\tID:a\tSM:s\n@RG\tID:b\tSM:s\n@PG\tID:bwa\n';
  assert.deepEqual(show(lint(rg + rec({ aux: 'RG:Z:a' }) + rec({ aux: 'RG:Z:b\tPG:Z:bwa' }) + rec({ aux: 'RG:Z:a' }))), []);
  const r = lint(rg + rec({ aux: 'RG:Z:c' }) + rec({ aux: 'RG:Z:a' }) + rec({ aux: 'RG:Z:c' }) + rec({ aux: 'RG:Z:c\tPG:Z:bwa.1' }));
  assert.deepEqual(codes(r), ['SAM209', 'SAM209', 'SAM209', 'SAM210']);
  assert.match(r.diagnostics[3]!.hint!, /PG:Z:bwa/);
  // Without any @RG line the specification only recommends one: a single warning, however many reads.
  assert.deepEqual(codes(lint(HEAD + rec({ aux: 'RG:Z:a' }) + rec({ aux: 'RG:Z:b' }), 'strict')), ['SAM211']);
  // A file without a header says nothing about read groups.
  assert.deepEqual(show(lint(rec({ flag: '4', rname: '*', pos: '0', cigar: '*', aux: 'RG:Z:a' }))), []);
});

test('@PG chains: forward references are fine, dangling ones are reported on their own line', () => {
  const chain = HEAD + '@PG\tID:c\tPP:b\n@PG\tID:b\tPP:a\n@PG\tID:a\n';
  assert.deepEqual(show(lint(chain + rec(), 'strict')), []);
  const r = lint(HEAD + '@PG\tID:c\tPP:b\n@PG\tID:b\tPP:zz\n' + rec());
  assert.deepEqual(show(r).map((s) => s.split(' ')[0]), ['SAM018@5:0']);
  // Also when the file ends with the header.
  assert.deepEqual(codes(lint(HEAD + '@PG\tID:b\tPP:zz\n')), ['SAM018', 'SAM303']);
});

test('coordinate order: references follow the @SQ lines, unplaced reads come last, one report per file', () => {
  const head = '@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr10\tLN:1000\n@SQ\tSN:chr2\tLN:1000\n';
  const un = rec({ flag: '4', rname: '*', pos: '0', cigar: '*' });
  assert.deepEqual(show(lint(head + rec({ rname: 'chr10', pos: '5' }) + rec({ rname: 'chr10', pos: '5' }) + rec({ rname: 'chr10', pos: '900' }) + rec({ rname: 'chr2', pos: '1' }) + un + un)), []);
  const r = lint(head + rec({ rname: 'chr2', pos: '1' }) + rec({ rname: 'chr10', pos: '5' }) + rec({ rname: 'chr10', pos: '1' }) + un + rec({ rname: 'chr2', pos: '7' }));
  assert.deepEqual(show(r).map((s) => s.split(' ')[0]), ['SAM301@5:6']);
  assert.match(r.diagnostics[0]!.notes![0]!, /ordered as their @SQ lines/);
  assert.deepEqual(codes(lint(head + un + rec({ rname: 'chr2', pos: '7' }))), ['SAM301']);
  // Without the claim in the header nothing is checked.
  assert.deepEqual(show(lint(HEAD + rec({ pos: '50' }) + rec({ pos: '5' }))), []);
});

test('queryname order: natural and lexicographic orders are both accepted', () => {
  const head = '@HD\tVN:1.6\tSO:queryname\n@SQ\tSN:chr1\tLN:1000\n';
  const file = (names: string[]) => head + names.map((qname) => rec({ qname })).join('');
  assert.deepEqual(show(lint(file(['r1', 'r2', 'r2', 'r9', 'r10', 'r100', 'ra']))), [], 'natural');
  assert.deepEqual(show(lint(file(['r1', 'r10', 'r100', 'r2', 'r2', 'r9', 'ra']))), [], 'lexicographic');
  assert.deepEqual(show(lint(file(['a:1:9', 'a:1:10', 'a:2:1', 'a:10:1']))), [], 'natural, several numbers');
  // A declared sub-sort order is held to.
  const ss = (order: string, names: string[]) => file(names).replace('SO:queryname', `SO:queryname\tSS:queryname:${order}`);
  assert.deepEqual(show(lint(ss('natural', ['r9', 'r10']))), []);
  assert.deepEqual(codes(lint(ss('natural', ['r10', 'r9']))), ['SAM302']);
  assert.deepEqual(codes(lint(ss('lexicographical', ['r9', 'r10']))), ['SAM302']);
  assert.deepEqual(show(lint(ss('lexicographical', ['r10', 'r9']))), []);
  // Neither: starts naturally, continues lexicographically.
  const r = lint(file(['r9', 'r10', 'r1', 'r3', 'r2']));
  assert.deepEqual(show(r).map((s) => s.split(' ')[0]), ['SAM302@5:1']);
});

test('blank lines: each one inside the file, one diagnostic with a fix at the end', () => {
  const text = HEAD + rec() + '\n\n' + rec({ qname: 'r2' }) + '\n\n';
  const r = lint(text);
  assert.deepEqual(show(r).map((s) => s.split(' ')[0]), ['SAM021@5:0', 'SAM021@6:0', 'SAM021@8:0']);
  assert.match(r.diagnostics[2]!.message, /2 blank lines at the end/);
  const fixed = new TextDecoder().decode(applyFixes(new TextEncoder().encode(text), r.diagnostics).output);
  assert.equal(fixed, HEAD + rec() + '\n\n' + rec({ qname: 'r2' }));
  assert.deepEqual(codes(lint('@HD\tVN:1.6\n\n@SQ\tSN:chr1\tLN:1000\n' + rec())), ['SAM021']);
  assert.deepEqual(codes(lint(HEAD + rec() + ' \t \n')), ['SAM021']);
});

test('lines starting with @ after the first alignment', () => {
  // A header line in the wrong place.
  assert.deepEqual(codes(lint(HEAD + rec() + '@CO\tlate comment\n')), ['SAM020']);
  assert.deepEqual(codes(lint(HEAD + rec() + '@RG\tID:x\n' + rec())), ['SAM020']);
  // An alignment whose read name starts with @, even one that looks like a record type.
  assert.deepEqual(codes(lint(HEAD + rec() + rec({ qname: '@r2' }))), ['SAM103']);
  assert.deepEqual(codes(lint(HEAD + rec() + rec({ qname: '@SQ' }))), ['SAM103']);
  // On the first alignment line the same name is taken for a header line, by samtools as well.
  assert.deepEqual(codes(lint(HEAD + rec({ qname: '@r2' }))), ['SAM002', 'SAM303']);
});

test('header: values that tools misread are errors, values they keep are warnings', () => {
  const h = (line: string) => lint('@HD\tVN:1.6\n' + line + '\n' + rec({ flag: '4', rname: '*', pos: '0', cigar: '*' }));
  for (const ln of ['0', '-5', '1,000', '1e3', '1000.0', 'abc']) assert.equal(severity(h(`@SQ\tSN:chr1\tLN:${ln}`), 'SAM011'), 'error', ln);
  assert.match(h('@SQ\tSN:chr1\tLN:1,000').diagnostics[0]!.hint!, /LN:1000/);
  assert.equal(severity(h('@SQ\tSN:chr1\tLN:1000\tLN:2000'), 'SAM011'), 'error');
  assert.equal(severity(h('@SQ\tSN:chr1\tLN:1000\tLN:1000'), 'SAM006'), 'warning');
  assert.equal(severity(h('@SQ\tSN:chr1\tLN:2147483648'), 'SAM012'), 'warning');
  assert.deepEqual(show(h('@SQ\tSN:chr1\tLN:2147483647')), []);
  // Names: `*` and `=` only matter in first position; `|`, `:` and `@` are legal.
  assert.deepEqual(show(h('@SQ\tSN:gi|123|ref:x@y*=\tLN:5')), []);
  for (const sn of ['*x', '=x', 'a,b', 'a b', 'a(b)', 'a<b>', 'a"b', "a'b", 'a\\b', 'a{b}', 'a[b]', 'a`b']) assert.deepEqual(codes(h(`@SQ\tSN:${sn}\tLN:5`)), ['SAM010'], sn);
  // Dates.
  for (const dt of ['2020', '2020-06', '2020-06-23', '20200623', '2020-06-23T12:13:47+01:00', '2020-06-23T12:13:47Z', '2020-06-23T12:13:47.250+0100', '2020-175', '2020-W26-2'])
    assert.deepEqual(show(h(`@RG\tID:a\tDT:${dt}`)), [], dt);
  for (const dt of ['2020-23-06', 'Tuesday', '23/06/2020', '2020-06-32', '2020-06-23T25:00', 'June 2020']) assert.deepEqual(codes(h(`@RG\tID:a\tDT:${dt}`)), ['SAM019'], dt);
  // Platform: lower case is a note, an unknown value a warning.
  assert.equal(severity(h('@RG\tID:a\tPL:illumina'), 'SAM023'), 'info');
  assert.match(h('@RG\tID:a\tPL:Nanopore').diagnostics[0]!.hint!, /PL:ONT/);
  // Non-ASCII text is allowed in DS, CL and @CO only.
  assert.deepEqual(show(lint('@HD\tVN:1.6\n@CO\tnaïve\n@PG\tID:a\tCL:echo é\tDS:é\n@RG\tID:r\tDS:é\n')).filter((s) => !s.startsWith('SAM303')), []);
  assert.deepEqual(codes(h('@RG\tID:a\tSM:échantillon')), ['SAM004']);
});

test('header: spaces for tabs', () => {
  const un = rec({ flag: '4', rname: '*', pos: '0', cigar: '*' });
  assert.deepEqual(codes(lint('@HD VN:1.6 SO:unsorted\n' + un)), ['SAM005']);
  assert.deepEqual(codes(lint('@HD\tVN:1.6\n@CO some text\n' + un)), ['SAM005']);
  // The ID swallowed the sample: legal as far as the pattern goes, so a warning in both profiles.
  const r = lint('@HD\tVN:1.6\n@RG\tID:rg1 SM:s1 PL:ILLUMINA\n' + un, 'strict');
  assert.deepEqual(codes(r), ['SAM022']);
  assert.equal(r.diagnostics[0]!.severity, 'warning');
  // Free text is left alone.
  assert.deepEqual(show(lint('@HD\tVN:1.6\n@PG\tID:bwa\tCL:bwa mem -R @RG\\tID:x ref.fa\tDS:see PN: bwa\n@RG\tID:x\tSM:my sample\tLB:lib 1\n' + un)), []);
});

test('fields: empty, non-canonical integers and ranges', () => {
  const fields = ['qname', 'flag', 'rname', 'pos', 'mapq', 'cigar', 'rnext', 'pnext', 'tlen', 'seq', 'qual'] as const;
  for (const f of fields) assert.deepEqual(codes(lint(HEAD + rec({ [f]: '' }))), ['SAM102'], f);
  for (const flag of ['-1', '65536', '+16', '016', '0x10', '4.0', 'x', '*', 'PAIRED']) assert.deepEqual(codes(lint(HEAD + rec({ flag }))), ['SAM105'], flag);
  assert.match(lint(HEAD + rec({ flag: '016' })).diagnostics[0]!.hint!, /becomes 14/);
  for (const pos of ['-1', '*', '1.5', '1e3', '0x20', '1,000']) assert.deepEqual(codes(lint(HEAD + rec({ pos }))), ['SAM110'], pos);
  assert.deepEqual(codes(lint(HEAD + rec({ pos: '010' }))), ['SAM122']);
  assert.deepEqual(codes(lint(HEAD + rec({ mapq: '+3' }))), ['SAM122']);
  assert.deepEqual(codes(lint(HEAD + rec({ tlen: '+200' }), 'strict')), ['SAM122']);
  assert.deepEqual(show(lint(HEAD + rec({ tlen: '-200' }) + rec({ tlen: '-2147483647', mapq: '255' }))), []);
  for (const mapq of ['256', '-1', '*', '30.0']) assert.deepEqual(codes(lint(HEAD + rec({ mapq }))), ['SAM113'], mapq);
  for (const tlen of ['*', '1.5', '--5', '-']) assert.deepEqual(codes(lint(HEAD + rec({ tlen }))), ['SAM117'], tlen);
  assert.deepEqual(codes(lint(HEAD + rec({ tlen: '-2147483648' }))), ['SAM111']);
  assert.deepEqual(codes(lint(HEAD + rec({ flag: '65', rnext: '=', pnext: '99999999999999999999' }))), ['SAM111']);
});

test('SEQ and QUAL', () => {
  assert.deepEqual(show(lint(HEAD + rec({ seq: 'acgtn', qual: '!~Aa*' }) + rec({ seq: '=ACMG', qual: '*' }) + rec({ cigar: '1M', seq: 'A', qual: '*' }) + rec({ seq: '*', qual: '*' }), 'strict')), []);
  for (const seq of ['AC-TA', 'AC*TA', 'AC1TA', 'AC TA', 'AC?TA']) assert.deepEqual(codes(lint(HEAD + rec({ seq }))), ['SAM118'], seq);
  for (const seq of ['ACGUA', 'AC.TA', 'ACETA']) assert.deepEqual(codes(lint(HEAD + rec({ seq }), 'strict')), ['SAM119'], seq);
  assert.deepEqual(codes(lint(HEAD + rec({ qual: 'IIII' }))), ['SAM120']);
  assert.deepEqual(codes(lint(HEAD + rec({ qual: 'IIIIII' }))), ['SAM120']);
  assert.deepEqual(codes(lint(HEAD + rec({ seq: '*', qual: 'IIIII' }))), ['SAM120']);
  assert.deepEqual(codes(lint(HEAD + rec({ qual: 'II II' }))), ['SAM121']);
  // A control character is reported by the engine's text rule, once.
  assert.deepEqual(codes(lint(HEAD + rec({ qual: 'II\x7fII' }))), ['TXT007']);
});

test('the result does not depend on how the input is cut into chunks', () => {
  const text = GOOD_SAM_EXAMPLES[2]! + rec({ rname: 'chrX', aux: 'RG:Z:nope\tNM:i:x' }) + rec({ rname: 'chrX', qname: 'a b', aux: 'RG:Z:nope' }) + '\n' + rec({ rname: 'chr1', aux: 'RG:Z:lane1' });
  const whole = show(lint(text));
  assert.ok(whole.length >= 6);
  const bytes = new TextEncoder().encode(text);
  for (const size of [1, 7, 64, 1000]) {
    const linter = createLinter({ filename: 't.sam', maxPerRule: 0 });
    for (let i = 0; i < bytes.length; i += size) linter.push(bytes.slice(i, i + size));
    const r = linter.end();
    assert.deepEqual(r.diagnostics.map((d) => `${d.code}@${d.line}:${d.column} ${d.message}`), whole, `chunks of ${size}`);
  }
});

test('damaged input never throws', () => {
  const base = GOOD_SAM_EXAMPLES[2]!;
  let seed = 12345;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const junk = ['\t', '\t\t', ':', '::', '*', '@', ' ', ',', '', '-1', '99999999999', 'B:', ':B:i,', '\n', '\n\n', '@SQ\t', 'é', '\x00', '=', 'M', '0'];
  for (let i = 0; i < 3000; i++) {
    let s = base;
    for (let k = 1 + rnd(3); k > 0; k--) {
      const at = rnd(s.length);
      const how = rnd(3);
      s = how === 0 ? s.slice(0, at) + s.slice(at + 1 + rnd(4)) : how === 1 ? s.slice(0, at) + junk[rnd(junk.length)] + s.slice(at) : s.slice(0, at) + junk[rnd(junk.length)] + s.slice(at + 1);
    }
    for (const profile of ['default', 'strict'] as const) {
      const r = lint(s, profile);
      for (const d of r.diagnostics) assert.ok(d.message.length > 5 && !/undefined|NaN|\[object/.test(d.message) && !/undefined|NaN|\[object/.test(d.hint ?? ''), `${d.code}: ${d.message} / ${d.hint}`);
    }
  }
  // Truncations at every byte of a small file.
  const small = GOOD_SAM_EXAMPLES[1]!;
  for (let i = 0; i < small.length; i++) lint(small.slice(0, i));
});

test('long lines and many records keep working', () => {
  const n = 200000;
  const long = HEAD.replace('LN:1000', 'LN:10000000') + rec({ cigar: `${n}M`, seq: 'ACGT'.repeat(n / 4), qual: 'I'.repeat(n), aux: 'XB:B:C' + ',255'.repeat(50000) });
  assert.deepEqual(show(lint(long)), []);
  const many = HEAD + Array.from({ length: 20000 }, (_, i) => rec({ qname: `q${i}`, pos: String(1 + (i % 900)), aux: `NM:i:${i % 3}\tRG:Z:g${i % 2}` })).join('');
  const r = lint(HEAD.trimEnd() + '\n@RG\tID:g0\n@RG\tID:g1\n' + many.slice(HEAD.length));
  assert.deepEqual(show(r), []);
  assert.equal(r.stats.records, 20000);
});
