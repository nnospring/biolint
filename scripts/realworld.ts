// Runs biolint (default profile) over real files produced by mainstream tools, taken from the nf-core test-datasets
// repository at a pinned commit. These files are accepted by the tools that the nf-core pipelines feed them to, so an
// error here is either a real defect in the file or a false positive in biolint.
//
//   node scripts/realworld.ts --fetch                 download the files listed in conformance/realworld.json
//   node scripts/realworld.ts [--format vcf] [--set dev|holdout|all] [--verbose]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lintFile } from '../src/node.ts';
import { formats } from '../src/index.ts';
import { ROOT } from './corpora.ts';

interface Entry { path: string; size: number; format: string }
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'conformance', 'realworld.json'), 'utf8')) as { commit: string; files: Entry[] };
const dir = join(ROOT, 'realworld');
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
/** Half of the files are never looked at while tuning rules; they are scored once for the report. */
export const setOf = (path: string): 'dev' | 'holdout' => (hash(path) % 2 === 0 ? 'dev' : 'holdout');

if (args.includes('--fetch')) {
  let n = 0;
  for (const f of manifest.files) {
    const dest = join(dir, f.path);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    const url = `https://raw.githubusercontent.com/nf-core/test-datasets/${manifest.commit}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const r = await fetch(url);
        if (r.ok) { writeFileSync(dest, new Uint8Array(await r.arrayBuffer())); ok = true; }
        else if (r.status === 404) break;
      } catch { /* retry */ }
      if (!ok) await new Promise((z) => setTimeout(z, 1500));
    }
    if (!ok) console.error(`could not fetch ${f.path}`);
    if (++n % 50 === 0) console.error(`${n} fetched`);
  }
  console.error('done');
  process.exit(0);
}

const only = opt('--format');
const set = opt('--set') ?? 'all';
const verbose = args.includes('--verbose');
const supported = new Set(formats.map((f) => f.id));
const rows: Record<string, { files: number; clean: number; withErrors: number; withWarnings: number; bytes: number; ms: number }> = {};
const failures: { path: string; set: string; format: string; checkedAs: string; errors: number; first: string; codes: string }[] = [];
for (const f of manifest.files) {
  if (!supported.has(f.format) || (only && f.format !== only)) continue;
  const s = setOf(f.path);
  if (set !== 'all' && s !== set) continue;
  const file = join(dir, f.path);
  if (!existsSync(file)) continue;
  const t0 = performance.now();
  // No format is forced: the file is detected from its name and content, exactly as a user would run it.
  const r = await lintFile(file, { maxPerRule: 2 });
  const key = `${f.format} (${s})`;
  const row = (rows[key] ??= { files: 0, clean: 0, withErrors: 0, withWarnings: 0, bytes: 0, ms: 0 });
  row.files++; row.bytes += r.bytes; row.ms += performance.now() - t0;
  if (r.counts.error) {
    row.withErrors++;
    const first = r.diagnostics.find((d) => d.severity === 'error')!;
    failures.push({ path: f.path, set: s, format: f.format, checkedAs: r.format, errors: r.counts.error, first: `${first.code} @${first.line}:${first.column} ${first.message}`, codes: Object.entries(r.byRule).filter(([, v]) => v.severity === 'error').map(([k, v]) => `${k}×${v.count}`).join(' ') });
  } else if (r.counts.warning) row.withWarnings++; else row.clean++;
  if (verbose && (r.counts.warning || r.counts.error)) console.log(`${f.path}\n    ${Object.entries(r.byRule).map(([k, v]) => `${k}×${v.count}`).join(' ')}`);
}
console.log('| Format (set) | Files | No findings | Warnings only | With errors | MB checked | MB/s |\n|---|---:|---:|---:|---:|---:|---:|');
for (const [k, r] of Object.entries(rows).sort()) console.log(`| ${k} | ${r.files} | ${r.clean} | ${r.withWarnings} | ${r.withErrors} | ${(r.bytes / 1e6).toFixed(1)} | ${(r.bytes / 1e6 / (r.ms / 1000)).toFixed(0)} |`);
for (const f of failures) console.log(`\n[${f.set}] ${f.path}${f.checkedAs !== f.format ? `  (checked as ${f.checkedAs})` : ''}\n    ${f.codes}\n    ${f.first}`);
if (set === 'all' && !only) {
  const root = join(import.meta.dirname, '..');
  writeFileSync(join(root, 'conformance', 'realworld-results.json'), JSON.stringify({ commit: manifest.commit, rows, failures }, null, 2) + '\n');
  // Report: the held-out half as first scored (frozen), what each flagged file turned out to be, and the current state.
  type Rows = typeof rows; type Failures = typeof failures;
  const frozenPath = join(root, 'conformance', 'holdout-first-run.json');
  const frozen = existsSync(frozenPath) ? JSON.parse(readFileSync(frozenPath, 'utf8')) as { rows: Rows; failures: Failures } : { rows, failures };
  const notes = JSON.parse(readFileSync(join(root, 'conformance', 'realworld-notes.json'), 'utf8')) as { path: string; kind: string; why: string }[];
  const noteFor = (p: string) => notes.find((n) => p.endsWith(n.path) || p.includes(n.path));
  const tableOf = (rs: Rows, which: string) => ['| Format | Files | No findings | Warnings only | With errors |', '|---|---:|---:|---:|---:|',
    ...Object.entries(rs).filter(([k]) => k.includes(`(${which})`)).sort().map(([k, r]) => `| ${k.replace(/ \(.*/, '')} | ${r.files} | ${r.clean} | ${r.withWarnings} | ${r.withErrors} |`),
    (() => { const t = Object.entries(rs).filter(([k]) => k.includes(`(${which})`)).reduce((a, [, r]) => [a[0]! + r.files, a[1]! + r.clean, a[2]! + r.withWarnings, a[3]! + r.withErrors], [0, 0, 0, 0]); return `| **Total** | **${t[0]}** | **${t[1]}** | **${t[2]}** | **${t[3]}** |`; })()].join('\n');
  const listOf = (fs: Failures, which: string) => fs.filter((f) => f.set === which).map((f) => { const n = noteFor(f.path); return `| \`${f.path.split('/').slice(-2).join('/')}\` | ${f.format} | ${n?.kind ?? '**unexplained**'} | ${n?.why ?? f.first} |`; });
  const kinds = (fs: Failures, which: string) => { const c: Record<string, number> = {}; for (const f of fs.filter((x) => x.set === which)) { const k = noteFor(f.path)?.kind ?? 'unexplained'; c[k] = (c[k] ?? 0) + 1; } return c; };
  const hk = kinds(frozen.failures, 'holdout');
  const md = ['# Real files', '', '<!-- Generated by `npm run realworld`. Do not edit by hand. -->', '',
    'biolint is run in its default profile over files that mainstream tools produce and consume: the',
    `[nf-core test datasets](https://github.com/nf-core/test-datasets) at commit \`${manifest.commit.slice(0, 12)}\` (${manifest.files.length} files of at most 4 MB each;`,
    'the list is in `conformance/realworld.json`). No format is forced: each file is detected from its name and content, as a user would run it.', '',
    'The files were split in two by a hash of their path. Rules were tuned on one half only. The other half was not looked at',
    'until every format was finished, and was then scored once. That first score is frozen in `conformance/holdout-first-run.json`.', '',
    '## Held-out half, first and only blind run', '', tableOf(frozen.rows, 'holdout'), '',
    `Of the ${Object.values(hk).reduce((a, b) => a + b, 0)} files with errors: ${Object.entries(hk).map(([k, v]) => `${v} ${k}`).join(', ')}.`, '',
    '| File | Format | What it was | Detail |', '|---|---|---|---|', ...listOf(frozen.failures, 'holdout'), '',
    'A false positive here means biolint reported an error on a file that its producing tool and common readers accept. Both were fixed after the run, so they no longer appear below.', '',
    '## Current state, both halves', '', '### Tuning half', '', tableOf(rows, 'dev'), '', '### Held-out half', '', tableOf(rows, 'holdout'), '',
    '| File | Format | What it is | Detail |', '|---|---|---|---|', ...listOf(failures, 'dev'), ...listOf(failures, 'holdout'), '',
    'These classifications are the judgement of the biolint authors. SAM has only two files in this collection; the SAM validator was additionally tuned and checked on',
    'several hundred files from the htslib, samtools and pysam test suites and from nf-core BAM files converted with samtools, a run that is not reproduced by this script.', ''].join('\n');
  writeFileSync(join(root, 'docs', 'REALWORLD.md'), md);
  const open = [...failures, ...frozen.failures].filter((f) => !noteFor(f.path));
  if (open.length) { console.error(`unexplained real-file failures: ${open.map((f) => f.path).join(', ')}`); process.exitCode = 1; }
}
