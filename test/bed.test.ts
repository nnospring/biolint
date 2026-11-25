import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFixes, lintText } from '../src/index.ts';
import type { LintResult } from '../src/index.ts';
import { GOOD_BED_EXAMPLES } from '../src/formats/bed/rules.ts';

const T = (s: string) => s.replace(/→/g, '\t');
const lint = (text: string, profile: 'default' | 'strict' = 'default', extra: Record<string, unknown> = {}) =>
  lintText(T(text), { filename: 'x.bed', profile, maxPerRule: 0, ...extra });
const codes = (r: LintResult, severity?: string) => r.diagnostics.filter((d) => !severity || d.severity === severity).map((d) => `${d.code}@${d.line}`);
const problems = (r: LintResult) => r.diagnostics.filter((d) => d.severity !== 'info').map((d) => `${d.code}@${d.line}:${d.column} ${d.message}`);
const spanOf = (text: string, r: LintResult, code: string) => {
  const d = r.diagnostics.find((x) => x.code === code)!;
  assert.ok(d, `no ${code} in ${codes(r).join(' ') || 'nothing'}`);
  return T(text).split('\n')[d.line - 1]!.slice(d.column - 1, d.endColumn - 1);
};

test('valid BED examples produce no diagnostics, in both profiles', () => {
  for (const text of GOOD_BED_EXAMPLES) {
    for (const profile of ['default', 'strict'] as const) {
      const r = lintText(text, { filename: 'ok.bed', profile });
      assert.deepEqual(r.diagnostics.map((d) => `${d.code}@${d.line}:${d.column} ${d.message}`), [], profile);
      assert.equal(r.format, 'bed');
    }
  }
});

// ------------------------------------------------------------------ how columns are read

test('the reading is reported as a summary value', () => {
  assert.equal(lint('chr1→0→10\n').stats['version'], 'BED3');
  assert.equal(lint('chr1→0→10→a→5→+\n').stats['version'], 'BED6');
  assert.equal(lint('chr1→0→10→a→5→+→x→y\n').stats['version'], 'BED6+2');
  assert.equal(lint('chr1→0→10→a→5→+\nchr1→20→30→b→7→-\n').stats['features'], 2);
});

test('narrowPeak is read as BED6+4 with one explanatory note and nothing else', () => {
  // The example from the UCSC description: column 7 is an integer here, but not a position inside the feature.
  const text = 'chr1→9356548→9356648→.→0→.→182→5.0945→-1→50\nchr1→9358722→9358822→.→0→.→91→4.6052→-1→40\nchr1→9361082→9361182→.→0→.→182→9.2103→-1→75\n';
  for (const profile of ['default', 'strict'] as const) {
    const r = lint(text, profile);
    assert.deepEqual(codes(r), ['BED013@1'], profile);
    assert.equal(r.stats['version'], 'BED6+4');
    const d = r.diagnostics[0]!;
    assert.match(d.message, /10 fields per line: read as BED6\+4 \(the ENCODE narrowPeak layout\)/);
    assert.match(d.message, /column 7 \(`182`\) does not fit thickStart/i);
    assert.match(d.hint!, /bed\.type=bed6\+4/);
  }
});

test('MACS-style narrowPeak with scores above 1000 and -1 values has no errors', () => {
  const text = 'chr1→100→600→peak_1→1840→.→25.31→190.2→184.0→211\nchr1→900→1500→peak_2→73→.→4.10→9.9→7.3→-1\n';
  const r = lint(text);
  assert.equal(r.counts.error, 0);
  assert.equal(r.stats['version'], 'BED6+4');
  // The score next to a strand column is still a score, and UCSC tools reject it: a warning, not an error.
  assert.deepEqual(codes(r, 'warning'), ['BED033@1']);
});

test('a ten-column narrowPeak does not look like a truncated BED12', () => {
  const r = lint('chr1→100→600→p1→500→+→25.31→190.2→184.0→211\n', 'strict');
  assert.deepEqual(codes(r).filter((c) => c.startsWith('BED014')), []);
  assert.equal(r.counts.error, 0);
});

test('broadPeak, summit files and bedGraph are accepted', () => {
  const broad = lint('chr1→100→600→region_1→312→.→5.2→12.1→9.8\nchr1→900→1500→region_2→88→.→2.2→4.0→-1\n');
  assert.deepEqual(problems(broad), []);
  assert.equal(broad.stats['version'], 'BED6+3');

  const summits = lint('chr1→350→351→peak_1→25.31\nchr1→1200→1201→peak_2→4.10\n');
  assert.deepEqual(problems(summits), []);
  assert.equal(summits.stats['version'], 'BED4+1');

  // Four-column bedGraph: the value sits where a name would, and anything is a legal name.
  const bg = lint('chr1→0→100→0.25\nchr1→100→200→-1.5\nchr1→200→300→1e-05\nchr1→300→400→0\n');
  assert.deepEqual(r2(bg), []);
  assert.equal(bg.stats['version'], 'BED4');

  const bgTrack = lint('track type=bedGraph name="signal"\nchr1→0→100→0.25\nchr1→100→200→1e-05\n');
  assert.deepEqual(problems(bgTrack), []);
  assert.deepEqual(codes(bgTrack), ['BED002@1']);
});
const r2 = (r: LintResult) => r.diagnostics.map((d) => `${d.code}@${d.line} ${d.message}`);

test('a column that stops fitting narrows the reading in the default profile and is an error in strict', () => {
  const text = 'chr1→0→100→a→0\nchr1→100→200→b→0\nchr1→200→300→c→0.37\nchr1→300→400→d→oops\n';
  const d = lint(text);
  assert.deepEqual(codes(d), ['BED013@3']);
  assert.equal(d.diagnostics[0]!.severity, 'info');
  assert.match(d.diagnostics[0]!.message, /column 5 \(`0\.37`\) does not fit score .* read as BED4\+1 instead of BED5/);
  assert.equal(spanOf(text, d, 'BED013'), '0.37');
  assert.equal(d.stats['version'], 'BED4+1');

  const s = lint(text, 'strict');
  assert.deepEqual(codes(s, 'error'), ['BED033@3', 'BED033@4']);
  assert.equal(s.stats['version'], 'BED5');
  // The first diagnostic that depends on the reading says what the reading is and how to change it.
  assert.match(s.diagnostics[0]!.notes!.join(' '), /5 fields per line, all read as standard fields \(BED5, inferred from line 1\).*bed\.type=bed4\+1/);
  assert.equal(s.diagnostics[1]!.notes, undefined);
});

test('a strand of + or - corroborates the columns to its left', () => {
  const text = 'chr1→0→100→a→0→+\nchr1→100→200→b→12.5→-\nchr1→200→300→c→7→fwd\n';
  const r = lint(text);
  assert.deepEqual(codes(r), ['BED033@2', 'BED035@3']);
  assert.equal(spanOf(text, r, 'BED033'), '12.5');
  assert.equal(spanOf(text, r, 'BED035'), 'fwd');
  assert.match(r.diagnostics[1]!.hint!, /write `\+`/);
  assert.equal(r.stats['version'], 'BED6');
});

test('a strand column that only ever held `.` is not proof', () => {
  const r = lint('chr1→0→100→a→0→.\nchr1→100→200→b→0→exon\n');
  assert.deepEqual(codes(r), ['BED013@2']);
  assert.equal(r.stats['version'], 'BED5+1');
});

test('custom columns are never checked', () => {
  const r = lint('chr1→0→100→a→0→+→1e+05→1,000→-5→ →→ x\nchr1→100→200→b→0→-→NA→→x y→3.5 →z→"q"\n');
  assert.deepEqual(problems(r), []);
  assert.equal(r.stats['version'], 'BED6+6');
});

test('an empty value narrows an uncorroborated column and is an error in a corroborated one', () => {
  // Custom fields may be empty in a tab-separated file, so this is a legal BED4+1.
  const text = 'chr1→0→100→a→5\nchr1→100→200→b→\n';
  const r = lint(text);
  assert.deepEqual(codes(r), ['BED013@2']);
  assert.match(r.diagnostics[0]!.message, /column 5 is empty.*read as BED4\+1 instead of BED5/);
  assert.equal(r.stats['version'], 'BED4+1');
  assert.deepEqual(codes(lint(text, 'strict'), 'error'), ['BED012@2']);
  // Next to a real strand column the empty score is a missing value.
  const c = lint('chr1→0→100→a→5→+\nchr1→100→200→b→→-\nchr1→200→300→→7→-\n');
  assert.deepEqual(codes(c), ['BED012@2', 'BED012@3']);
  assert.match(c.diagnostics[0]!.message, /score is empty/);
  assert.match(c.diagnostics[1]!.message, /name is empty/);
});

test('spaces at the edge of a name are content; next to a mandatory or corroborated field they are separators', () => {
  const name = lint('chr1→100→200→gene A→0→+\nchr1→300→400→gene B →0→-\nchr1→500→600→ gene C→0→-\n');
  assert.deepEqual(codes(name), ['BED030@1', 'BED030@2', 'BED030@3']);
  assert.equal(name.counts.error, 0);
  const strand = lint('chr1→100→200→a→0→+\nchr1→300→400→b→0 →-\n');
  assert.deepEqual(codes(strand), ['BED009@2']);
  // An uncorroborated last column is not touched.
  assert.equal(lint('chr1→100→200→a→note one\nchr1→300→400→b→ note two \n').counts.error, 0);
});

test('bedMethyl (BED9+2) is not taken for a truncated BED12', () => {
  const text = 'chr1→10468→10469→.→1→+→10468→10469→255,0,0→1→100\nchr1→10470→10471→.→12→-→10470→10471→0,255,0→12→0\n';
  for (const profile of ['default', 'strict'] as const) {
    const r = lint(text, profile);
    assert.deepEqual(codes(r), ['BED013@1'], profile);
    assert.equal(r.stats['version'], 'BED9+2');
  }
  // A real BED12 that lost its last column still is.
  assert.deepEqual(codes(lint('chr22→1000→5000→cloneA→960→+→1000→5000→0→2→567,488\n')), ['BED014@1']);
});

test('BED12 with extra columns: blocks are checked, extras are not', () => {
  const ok = 'chr1→1000→5000→t1→0→+→1200→4800→0→2→567,488,→0,3512,→extra→1.5\n';
  const r = lint(ok + 'chr1→1000→5000→t2→0→-→1200→4800→0→2→567,488→0,3000→extra→2.5\n');
  assert.deepEqual(codes(r), ['BED013@1', 'BED044@2']);
  assert.equal(r.stats['version'], 'BED12+2');
});

test('three plain integer columns after BED9 are not taken for blocks', () => {
  const r = lint('chr1→1000→5000→t1→0→+→1200→4800→0→3→7→9\nchr1→6000→7000→t2→0→+→6000→7000→0→12→0→4\n');
  assert.deepEqual(problems(r), []);
  assert.equal(r.stats['version'], 'BED9+3');
});

test('bed.type declares the layout instead of inferring it', () => {
  const text = 'chr1→0→100→a→0.37\nchr1→100→200→b→0.5\n';
  assert.deepEqual(codes(lint(text)), ['BED013@1']);
  const forced = lint(text, 'default', { formatOptions: { bed: { type: 'bed5' } } });
  assert.deepEqual(codes(forced), ['BED033@1', 'BED033@2']);
  const custom = lint('chr1→0→100→a→0→+\n', 'strict', { formatOptions: { bed: { type: 'bed4+2' } } });
  assert.deepEqual(codes(custom), []);
  assert.equal(custom.stats['version'], 'BED4+2');
});

// ------------------------------------------------------------------ separators

test('a space-separated file gets one warning, and its fields are still checked', () => {
  const text = 'chr7    127471196  127472363  Pos1  0  +\nchr7    127472363  127473530  Pos2  0  +\nchr7    127473530  127473000  Neg1  0  -\n';
  for (const profile of ['default', 'strict'] as const) {
    const r = lint(text, profile);
    assert.deepEqual(codes(r), ['BED008@1', 'BED023@3'], profile);
    assert.equal(r.diagnostics[0]!.severity, 'warning');
    assert.equal(r.stats['version'], 'BED6');
  }
});

test('mixed separators are located exactly; error by default, warning in strict', () => {
  const text = 'chr1→100→200→a\nchr1 300 400 b\nchr1→500 →600→c\nchr1→700→ 800→d\nchr1→→900→950→e\nchr1→960→970→f\n';
  const r = lint(text);
  assert.deepEqual(codes(r), ['BED009@2', 'BED009@3', 'BED009@4', 'BED009@5']);
  assert.ok(r.diagnostics.every((d) => d.severity === 'error'));
  assert.match(r.diagnostics[0]!.message, /this line is separated by spaces; the lines before it \(from line 1\) use tabs/);
  assert.match(r.diagnostics[1]!.message, /a space before the tab between fields 2 and 3/);
  assert.match(r.diagnostics[2]!.message, /a space after the tab between fields 2 and 3/);
  assert.match(r.diagnostics[3]!.message, /two tabs in a row/);
  const lines = T(text).split('\n');
  const d3 = r.diagnostics[1]!;
  assert.equal(lines[2]!.slice(d3.column - 1, d3.endColumn - 1), ' \t');
  assert.equal(r.stats['features'], 6);

  const s = lint(text, 'strict');
  assert.equal(s.counts.error, 0);
  assert.deepEqual(codes(s, 'warning'), ['BED009@2', 'BED009@3', 'BED009@4', 'BED009@5']);
});

test('stray separators and trailing whitespace can be repaired mechanically', () => {
  const text = T('chr1→100→200→a→0→+\nchr1 300 400 b 0 -\nchr1 →500→ 600→c→0→+\nchr1→→700→800→d→0→-\nchr1→900→950→e→0→+→\nchr1→960→970→f→0→- \n');
  const before = lintText(text, { filename: 'x.bed', maxPerRule: 0 });
  assert.deepEqual(codes(before), ['BED009@2', 'BED009@3', 'BED009@4', 'BED007@5', 'BED007@6']);
  const fixed = applyFixes(new TextEncoder().encode(text), before.diagnostics);
  const out = new TextDecoder().decode(fixed.output);
  assert.equal(out, T('chr1→100→200→a→0→+\nchr1→300→400→b→0→-\nchr1→500→600→c→0→+\nchr1→700→800→d→0→-\nchr1→900→950→e→0→+\nchr1→960→970→f→0→-\n'));
  assert.deepEqual(codes(lintText(out, { filename: 'x.bed' })), []);
});

test('values are still checked on a line with a stray separator', () => {
  const r = lint('chr1→100→200→a→0→+\nchr1 →300→250→b→0→+\n');
  assert.deepEqual(codes(r), ['BED009@2', 'BED023@2']);
});

test('a space inside a name is content, not a separator, in a tab-separated file', () => {
  const text = 'chr1→100→200→gene A→0→+\nchr1→300→400→gene B→0→-\n';
  const r = lint(text);
  assert.deepEqual(codes(r), ['BED030@1', 'BED030@2']);
  assert.equal(r.counts.error, 0);
  assert.equal(r.stats['version'], 'BED6');
  assert.match(r.diagnostics[0]!.hint!, /gene_A/);
  assert.equal(lint(text, 'strict').counts.error, 0);
});

test('a tab in a space-separated file is reported', () => {
  const r = lint('chr1 100 200\nchr1→300→400\n');
  assert.deepEqual(codes(r), ['BED008@1', 'BED009@2']);
});

test('field count: trailing tab, missing and extra fields', () => {
  const r = lint('chr1→100→200→a\nchr1→300→400→b→\nchr1→500→600\nchr1→700→800→c→d\n');
  assert.deepEqual(codes(r), ['BED007@2', 'BED011@3', 'BED011@4']);
  assert.match(r.diagnostics[1]!.message, /line has 3 fields, but line 1 has 4/);
  assert.match(r.diagnostics[2]!.message, /line has 5 fields, but line 1 has 4/);
});

test('comma-separated and region-style lines get a specific hint', () => {
  const csv = lint('chr1,100,200,geneA\n');
  assert.deepEqual(codes(csv), ['BED010@1']);
  assert.match(csv.diagnostics[0]!.hint!, /comma-separated/);
  const region = lint('chr1:1,001-5,000\n');
  assert.match(region.diagnostics[0]!.hint!, /`chr1\\t1000\\t5000`/);
});

// ------------------------------------------------------------------ browser, track, comment and blank lines

test('browser and track lines at the top: a note by default, an error in strict', () => {
  const text = 'browser position chr7:127471196-127495720\nbrowser hide all\ntrack name="ItemRGBDemo" description="Item RGB demonstration" itemRgb="On"\nchr7→127471196→127472363→Pos1→0→+→127471196→127472363→255,0,0\n';
  const d = lint(text);
  assert.deepEqual(codes(d), ['BED002@1', 'BED002@2', 'BED002@3']);
  assert.ok(d.diagnostics.every((x) => x.severity === 'info'));
  assert.equal(d.stats['version'], 'BED9');
  assert.deepEqual(codes(lint(text, 'strict'), 'error'), ['BED002@1', 'BED002@2', 'BED002@3']);
});

test('a second track may have a different layout', () => {
  const r = lint('track name=a\nchr1→100→200\nchr1→300→400\ntrack name=b\nchr1→100→200→x→0→+\nchr1→50→60→y→0→-\n');
  assert.deepEqual(codes(r), ['BED002@1', 'BED003@4', 'BED025@6']);
  assert.equal(r.counts.error, 0);
});

test('a chromosome called track1 is not a track line', () => {
  assert.deepEqual(codes(lint('track1→100→200\nbrowserX→5→6\n')), []);
});

test('data of a non-BED track type is left alone', () => {
  const r = lint('track type=wiggle_0 name="w"\nvariableStep chrom=chr19 span=150\n49304701 10.0\n49304901 12.5\n');
  assert.deepEqual(codes(r), ['BED002@1']);
});

test('comments may appear anywhere; an indented # is not a comment', () => {
  assert.deepEqual(codes(lint('# header\nchr1→100→200\n# middle\n#chr1→1→2\nchr1→300→400\n# end\n')), []);
  const r = lint('chr1→100→200\n  # not a comment\n');
  assert.deepEqual(codes(r), ['BED006@2']);
  assert.match(r.diagnostics[0]!.message, /not a comment/);
});

test('blank and whitespace-only lines are reported but do not break the reading', () => {
  const r = lint('chr1→100→200\n\n\nchr1→300→400\n→ \nchr1→500→600\n');
  assert.deepEqual(codes(r), ['BED005@2', 'BED005@3', 'BED005@5']);
  assert.ok(r.diagnostics.every((d) => d.severity === 'warning'));
  assert.match(r.diagnostics[2]!.message, /only spaces or tabs/);
  assert.equal(lint('chr1→100→200\n\nchr1→300→400\n', 'strict').diagnostics[0]!.severity, 'info');
});

test('an uncommented column header is recognised and can be fixed', () => {
  for (const header of ['chrom→chromStart→chromEnd→name', 'Chromosome→Start→End→Gene', 'chr→begin→stop→id', 'seqnames→from→to→label']) {
    const r = lint(`${header}\nchr1→100→200→a\nchr1→300→400→b\n`);
    assert.deepEqual(codes(r), ['BED004@1'], header);
    assert.equal(r.diagnostics[0]!.fix!.edits![0]!.text, '#');
    assert.equal(r.stats['features'], 2);
  }
  // Only the first line can be a header.
  assert.deepEqual(codes(lint('chr1→100→200\nchrom→start→end\n')), ['BED022@2']);
});

// ------------------------------------------------------------------ coordinates

test('number artefacts in chromStart and chromEnd get specific hints', () => {
  const cases: [string, RegExp, RegExp][] = [
    ['1e+05', /scientific notation/, /write `100000`.*scipen/],
    ['1E5', /scientific notation/, /write `100000`/],
    ['2.5e+06', /scientific notation/, /write `2500000`/],
    ['1,000,000', /thousands separators/, /`1000000`/],
    ['100.0', /decimal point/, /write `100`/],
    ['100.5', /not a whole number/, /round or truncate/],
    ['-1', /is negative/, /clamp it to `0`/],
    ['+100', /plus sign/, /write `100`/],
    ['"100"', /quotation mark/, /quote = FALSE/],
    ['NA', /missing-value marker/, /./],
    ['abc', /is not a number/, /digits only/],
    ['18446744073709551616', /larger than 2\^64/, /./],
  ];
  for (const [value, message, hint] of cases) {
    const text = `chr1→${value}→900000000\n`;
    const r = lint(text);
    assert.equal(r.diagnostics.length, 1, value);
    const d = r.diagnostics[0]!;
    assert.equal(d.severity, 'error', value);
    assert.match(d.message, message, value);
    assert.match(d.hint!, hint, value);
    assert.equal(T(text).split('\n')[0]!.slice(d.column - 1, d.endColumn - 1), value);
  }
});

test('scientific notation is only a problem in standard fields', () => {
  assert.deepEqual(problems(lint('chr1→100→200→1e+05\nchr1→300→400→2e+05\n')), []);                // a name
  assert.deepEqual(problems(lint('chr1→100→200→a→0→+→1e+05\nchr1→300→400→b→0→-→2e+05\n')), []);    // a custom column
  assert.deepEqual(codes(lint('chr1→100→200→a→0→+→100→200\nchr1→300→400→b→0→-→3e+02→400\n')), ['BED036@2']); // thickStart
});

test('start greater than end points at both numbers and explains the conventions', () => {
  const text = 'chr1→5000→1000→a\n';
  const r = lint(text);
  assert.deepEqual(codes(r), ['BED023@1']);
  assert.equal(spanOf(text, r, 'BED023'), '5000\t1000');
  assert.match(r.diagnostics[0]!.hint!, /BED counts from 0 and excludes the end/);
  // start = end + 1 is what a zero-length feature looks like after a wrong 1-based conversion.
  assert.match(lint('chr1→101→100\n').diagnostics[0]!.hint!, /zero-length feature/);
  // A zero-length feature itself is fine, and nothing guesses at 1-based input.
  assert.deepEqual(codes(lint('chr1→0→0\nchr1→1→1\nchr1→100→100\n')), []);
});

test('coordinates up to 2^64-1 are compared exactly', () => {
  assert.deepEqual(codes(lint('chr1→18446744073709551614→18446744073709551615\n')), ['BED024@1']);
  assert.deepEqual(codes(lint('chr1→18446744073709551615→18446744073709551614\n')), ['BED023@1']);
  assert.deepEqual(codes(lint('chr1→0→4294967295\n')), []);
  assert.equal(lint('chr1→0→4294967296\n').diagnostics[0]!.severity, 'warning');
  assert.deepEqual(codes(lint('chr1→000100→000200\n', 'strict')), []);
});

test('chromosome names: any name by default, the specification\'s alphabet in strict', () => {
  const text = 'MT192765.1→100→200\nHLA-A*01:01→5→10\nm84098_241004_143555_s2/160175827/ccs→0→150\n';
  assert.deepEqual(problems(lint(text)), []);
  const s = lint(text, 'strict');
  assert.deepEqual(codes(s, 'error'), ['BED020@1', 'BED020@2', 'BED020@3']);
  assert.equal(spanOf(text, s, 'BED020'), '.');
  assert.deepEqual(codes(lint(`${'c'.repeat(256)}→1→2\n`, 'strict'), 'error'), ['BED020@1']);
  assert.deepEqual(codes(lint('chrUn_KI270442v1→1→2\n', 'strict')), []);
});

test('mixed chr1 / 1 naming is reported once', () => {
  const r = lint('chr1→100→200\nchr2→100→200\n1→100→200\n2→100→200\nchrX→1→2\n');
  assert.deepEqual(codes(r), ['BED021@3']);
  assert.match(r.diagnostics[0]!.message, /line 1 uses the other style/);
  assert.deepEqual(codes(lint('chr1→1→2\nscaffold_1→1→2\nchrUn_1→1→2\n')), []);
});

test('sortedness is a single note, covering order and split chromosomes', () => {
  const pos = lint('chr1→300→400\nchr1→100→200\nchr1→50→60\n');
  assert.deepEqual(codes(pos), ['BED025@2']);
  assert.equal(pos.diagnostics[0]!.severity, 'info');
  const split = lint('chr1→100→200\nchr2→100→200\nchr1→300→400\n', 'strict');
  assert.deepEqual(codes(split), ['BED025@3']);
  assert.equal(split.diagnostics[0]!.severity, 'warning');
  assert.match(split.diagnostics[0]!.message, /not together/);
  assert.deepEqual(codes(lint('chr10→1→2\nchr2→1→2\nchr1→5→6\nchr1→5→9\nchr1→5→7\n')), []);
});

test('very many chromosome names do not accumulate without bound', () => {
  const lines: string[] = [];
  for (let i = 0; i < 120_000; i++) lines.push(`read_${i}/ccs\t0\t150`);
  lines.push('read_5/ccs\t0\t150'); // a repeat after the cap is no longer noticed, by design
  const r = lintText(lines.join('\n') + '\n', { filename: 'x.bed' });
  assert.deepEqual(codes(r), []);
  assert.equal(r.stats['features'], 120_001);
});

// ------------------------------------------------------------------ name, score, strand, thick, rgb

test('spreadsheet-mangled gene symbols: reported for the exact spreadsheet forms only', () => {
  for (const name of ['1-Mar', '2-Sep', 'Sep-07', '7-Dec', '10-Mar', '4-Oct', '2.31E+13']) {
    const r = lint(`chr1→100→200→${name}→0→+\n`);
    assert.deepEqual(codes(r), ['BED032@1'], name);
    assert.equal(r.diagnostics[0]!.severity, 'warning');
  }
  assert.match(lint('chr1→100→200→1-Mar\n').diagnostics[0]!.message, /`MARCH1` or `MARC1`/);
  assert.match(lint('chr1→100→200→2-Sep\n').diagnostics[0]!.message, /`SEPT2`/);
  for (const name of ['MARCH1', 'SEPT2', 'DEC1', 'Mar-1', '1-mar', '1-MAR', '32-Mar', '0-Mar', '1-March', 'x1-Mar', '1-Mar-2020', 'peak-12', 'Sep-7', '2-Sept', '2.31e+13', '12.5E+13', 'A-Mar', '1_Mar']) {
    assert.deepEqual(codes(lint(`chr1→100→200→${name}→0→+\n`)), [], name);
  }
  // Only the name column is examined.
  assert.deepEqual(problems(lint('chr1→100→200→g→0→+→1-Mar\n')), []);
});

test('score: range, notation and the `.` placeholder', () => {
  assert.deepEqual(codes(lint('chr1→1→2→a→0→+\nchr1→3→4→b→1000→-\nchr1→5→6→c→007→.\n', 'strict')), []);
  const r = lint('chr1→1→2→a→1001→+\nchr1→3→4→b→-1→+\nchr1→5→6→c→1e+05→+\nchr1→7→8→d→.→+\n');
  assert.deepEqual(codes(r), ['BED033@1', 'BED033@2', 'BED033@3', 'BED034@4']);
  assert.deepEqual(r.diagnostics.map((d) => d.severity), ['warning', 'warning', 'warning', 'info']);
  assert.equal(lint('chr1→1→2→a→.→+\n', 'strict').counts.error, 1);
});

test('strand hints recognise common spellings', () => {
  const hintFor = (v: string) => lint(`chr1→1→2→a→0→+\nchr1→3→4→b→0→${v}\n`).diagnostics.find((d) => d.code === 'BED035')!.hint!;
  assert.match(hintFor('forward'), /write `\+`/);
  assert.match(hintFor('-1'), /write `-`/);
  assert.match(hintFor('*'), /write `\.`.*Bioconductor/);
});

test('thick positions: absolute, ordered, inside the feature', () => {
  const head = 'chr1→1000→5000→a→0→+→1000→5000→0\n';
  assert.deepEqual(codes(lint(head + 'chr1→6000→7000→b→0→+→6000→6000→0\nchr1→8000→9000→c→0→-→9000→9000→0\n', 'strict')), []);
  const r = lint(head + 'chr1→6000→7000→b→0→+→200→800→0\nchr1→8000→9000→c→0→+→8500→8400→0\nchr1→8000→9000→c→0→+→8500→9001→0\n');
  assert.deepEqual(codes(r), ['BED037@2', 'BED037@2', 'BED037@3', 'BED037@4']);
  assert.ok(r.diagnostics.every((d) => d.severity === 'warning'));
  assert.match(r.diagnostics[0]!.hint!, /did you mean `6200`/);
  assert.match(r.diagnostics[2]!.message, /before thickStart `8500`/);
});

test('itemRgb forms', () => {
  const line = (rgb: string) => `chr1→1000→5000→a→0→+→1000→5000→255,0,0\nchr1→6000→7000→b→0→+→6000→7000→${rgb}\n`;
  for (const ok of ['0', '0,0,0', '255,255,255', '000,128,064']) assert.deepEqual(codes(lint(line(ok), 'strict')), [], ok);
  const hints: [string, RegExp][] = [['#FF0000', /`255,0,0`/], ['red', /colour names/], ['255,0', /three values/], ['255,0,0,', /trailing comma/], ['256,0,0', /`256` is too large/], ['16711680', /single number/], ['255, 0, 0', /remove the spaces/]];
  for (const [bad, hint] of hints) {
    const r = lint(line(bad));
    assert.deepEqual(codes(r), ['BED038@2'], bad);
    assert.match(r.diagnostics[0]!.hint!, hint, bad);
  }
});

// ------------------------------------------------------------------ blocks

test('block lists: trailing commas, single blocks, touching blocks', () => {
  const ok = [
    'chr1→1000→5000→a→0→+→1000→5000→0→2→567,488,→0,3512,',
    'chr1→1000→5000→a→0→+→1000→5000→0→2→567,488→0,3512',
    'chr1→1000→5000→a→0→+→1000→5000→0→1→4000→0',
    'chr1→1000→5000→a→0→+→1000→5000→0→1→4000,→0,',
    'chr1→1000→5000→a→0→+→1000→5000→0→2→2000,2000→0,2000',
    'chr1→1000→1031→a→0→-→1000→1031→0→31→' + Array(31).fill('1').join(',') + '→' + Array.from({ length: 31 }, (_, i) => i).join(','),
  ];
  assert.deepEqual(codes(lint(ok.join('\n') + '\n', 'strict')), []);
});

test('block problems are located and explained', () => {
  const head = 'chr1→1000→5000→a→0→+→1000→5000→0→2→567,488→0,3512\n';
  const row = (count: string, sizes: string, starts: string) => `chr1→1000→5000→b→0→+→1000→5000→0→${count}→${sizes}→${starts}\n`;
  const check = (count: string, sizes: string, starts: string, code: string, span: string, hint?: RegExp) => {
    const text = head + row(count, sizes, starts);
    const r = lint(text);
    assert.deepEqual(codes(r), [`${code}@2`], `${count} ${sizes} ${starts}`);
    assert.equal(spanOf(text, r, code), span);
    if (hint) assert.match(r.diagnostics[0]!.hint!, hint);
  };
  check('0', '567,488', '0,3512', 'BED040', '0');
  check('-2', '567,488', '0,3512', 'BED040', '-2');
  check('2', '567,-488', '0,3512', 'BED041', '-');
  check('2', '567, 488', '0,3512', 'BED041', ' ');
  check('2', '567,,488', '0,3512', 'BED041', ',,');
  check('3', '567,488', '0,3512', 'BED042', '567,488', /set blockCount to `2`/);
  check('2', '567,488', '0', 'BED042', '0', /truncated/);
  check('2', '567488', '0,3512', 'BED042', '567488', /commas between the values are missing/);
  check('2', '567,488', '1000,4512', 'BED043', '1000', /subtract `1000`/);
  check('2', '567,488', '3512,0', 'BED045', '3512,0', /minus strand/);
  check('2', '567,488', '0,500', 'BED045', '500', /may touch but not overlap/);
  check('3', '100,100,3000', '0,2000,1000', 'BED045', '1000', /left to right/);
  check('2', '567,488', '0,3600', 'BED046', '3600');
  check('2', '567,400', '0,3512', 'BED044', '400', /last block size to `488`/);
});

// ------------------------------------------------------------------ other content, detection

test('a PLINK binary .bed is named for what it is', () => {
  const bytes = new Uint8Array([0x6c, 0x1b, 0x01, 0xff, 0xef, 0x0a, 0x33, 0x09, 0x09]);
  const r = lintText(bytes, { filename: 'cohort.bed' });
  // The engine recognises the signature before any BED rule runs, so there is exactly one diagnostic.
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['TXT011']);
  assert.match(r.diagnostics[0]!.message, /PLINK binary genotype/);
  assert.match(r.diagnostics[0]!.hint!, /UCSC BED/);
});

test('content detection: BED-like lines are recognised, other tab-separated formats are not taken', () => {
  const detect = (text: string) => lintText(T(text), { filename: 'data.txt' }).format;
  assert.equal(detect('chr1→100→200\nchr1→300→400\n'), 'bed');
  assert.equal(detect('# comment\nchr1→100→200→a→0→+\n'), 'bed');
  assert.equal(detect('track name=x\nchr1 100 200\n'), 'bed');
  assert.equal(detect('chr1    100    200    a\nchr1    300    400    b\n'), 'bed');
  assert.notEqual(detect('chr1→src→gene→100→200→.→+→.→ID=g1\n'), 'bed');
  assert.notEqual(detect('chr1→src→exon→100→200→.→+→.→gene_id "g"; transcript_id "t";\n'), 'bed');
  assert.notEqual(detect('chr1→100→.→A→T→50→PASS→DP=3\n'), 'bed');
  assert.notEqual(detect('read1→0→1→100→60→4M→*→0→0→ACGT→IIII\n'), 'bed');          // SAM with a numeric reference name
  assert.notEqual(detect('read1→99→chr1→100→60→4M→=→300→204→ACGT→IIII\n'), 'bed');
  assert.notEqual(detect('gene→sample1→sample2\nA→1→2\n'), 'bed');
});

test('narrowPeak, broadPeak and bedGraph file names are checked as BED', () => {
  for (const name of ['peaks.narrowPeak', 'peaks.broadPeak.gz', 'signal.bedGraph', 'x.gappedPeak']) {
    const r = lintText('chr1\t100\t200\tp\t0\t.\t1.5\t2.5\t3.5\t10\n', { filename: name });
    assert.equal(r.format, 'bed', name);
    assert.equal(r.formatSource, 'extension', name);
  }
});

test('another format saved as .bed is named', () => {
  const sam = lintText('@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr1\tLN:1000\n', { format: 'bed', filename: 'x.bed' });
  assert.deepEqual(codes(sam), ['BED001@1']);
  assert.match(sam.diagnostics[0]!.message, /SAM/);
  assert.deepEqual(codes(lintText('>chr1 some sequence\nACGT\n', { format: 'bed', filename: 'x.bed' })), ['BED001@1']);
});
