// Scores biolint against third-party labelled corpora and writes docs/CONFORMANCE.md.
// Usage: node scripts/conformance.ts [--list-disagreements] [--suite name]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { lintText } from '../src/index.ts';
import type { LintResult } from '../src/index.ts';
import { CORPORA, ROOT } from './corpora.ts';

import { adjudicationsFor, modules, suites as SUITES } from '../conformance/index.ts';
import type { Adjudication } from '../conformance/types.ts';

function adjudicate(format: string, id: string, label: string, cause: string): Adjudication | undefined {
  return adjudicationsFor(format).find((a) => a.label === label && (!a.path || a.path.test(id)) && (!a.cause || a.cause.test(cause)));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const only = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : undefined;
const listAll = args.includes('--list-disagreements');

interface Row { suite: string; format: string; files: number; agree: number; falseAccept: string[]; falseReject: string[] }
const rows: Row[] = [];
const disagreements: { id: string; format: string; label: string; got: string; first: string; cause: string; verdict: string | null; why: string | null }[] = [];

for (const s of SUITES) {
  if (only && !s.name.includes(only)) continue;
  const base = join(ROOT, s.corpus, s.dir);
  if (!existsSync(base)) { console.error(`missing ${base}: run \`node scripts/corpora.ts\` first`); process.exit(2); }
  const row: Row = { suite: s.name, format: s.format, files: 0, agree: 0, falseAccept: [], falseReject: [] };
  for (const file of walk(base).sort()) {
    const rel = relative(base, file);
    if (!s.include.test(rel) || (s.exclude && s.exclude.test(rel))) continue;
    const label = s.label(rel);
    if (!label) continue;
    let bytes: Uint8Array = readFileSync(file);
    if (file.endsWith('.gz')) bytes = gunzipSync(bytes);
    let res: LintResult;
    try { res = lintText(bytes, { format: s.format, filename: rel, profile: 'strict', maxPerRule: 3 }); }
    catch (e) { console.error(`CRASH on ${file}: ${(e as Error).stack}`); process.exit(3); }
    const got = res.counts.error > 0 ? 'invalid' : 'valid';
    row.files++;
    const id = `${s.corpus}/${s.dir}/${rel}`;
    if (got === label) row.agree++;
    else {
      (label === 'invalid' ? row.falseAccept : row.falseReject).push(id);
      const first = res.diagnostics.find((d) => d.severity === 'error');
      const cause = /^##CauseOfFailure=(.*)$/m.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 4096)))?.[1]?.trim() ?? '';
      const adj = adjudicate(s.format, id, label, cause);
      disagreements.push({ id, format: s.format, label, got, cause, verdict: adj?.verdict ?? null, why: adj?.why ?? null, first: first ? `${first.code} ${first.name} @${first.line}:${first.column} ${first.message}` : '(no errors reported)' });
    }
  }
  rows.push(row);
}

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
const total = rows.reduce((t, r) => ({ files: t.files + r.files, agree: t.agree + r.agree, fa: t.fa + r.falseAccept.length, fr: t.fr + r.falseReject.length }), { files: 0, agree: 0, fa: 0, fr: 0 });
const table = [
  '| Suite | Files | Agree | Accepted but labelled invalid | Rejected but labelled valid |',
  '|---|---:|---:|---:|---:|',
  ...rows.map((r) => `| ${r.suite} | ${r.files} | ${r.agree} (${pct(r.agree, r.files)}) | ${r.falseAccept.length} | ${r.falseReject.length} |`),
  `| **Total** | **${total.files}** | **${total.agree} (${pct(total.agree, total.files)})** | **${total.fa}** | **${total.fr}** |`,
].join('\n');
console.log(table);

const byVerdict: Record<string, number> = {};
let open = 0;
for (const d of disagreements) { if (d.verdict) byVerdict[d.verdict] = (byVerdict[d.verdict] ?? 0) + 1; else open++; }
console.log(`\ndisagreements: ${disagreements.length}; adjudicated: ${JSON.stringify(byVerdict)}; open: ${open}`);
if (listAll) for (const d of disagreements) console.log(`${(d.verdict ?? 'OPEN').padEnd(16)} ${d.label === 'invalid' ? 'ACCEPTED' : 'REJECTED'} ${d.id}\n      ${d.cause ? 'cause: ' + d.cause + ' | ' : ''}${d.first}`);
else for (const d of disagreements) if (!d.verdict) console.log(`OPEN ${d.label === 'invalid' ? 'ACCEPTED' : 'REJECTED'} ${d.id}\n      ${d.cause ? 'cause: ' + d.cause + ' | ' : ''}${d.first}`);

if (!only) {
  writeFileSync(join(import.meta.dirname, '..', 'conformance', 'results.json'), JSON.stringify({ corpora: CORPORA.map((c) => ({ name: c.name, repo: c.repo, commit: c.commit })), rows, disagreements }, null, 2) + '\n');
  // Human-readable report.
  const groups = new Map<string, { verdict: string; why: string; label: string; n: number; example: string }>();
  for (const d of disagreements) {
    const k = (d.verdict ?? 'open') + '|' + (d.why ?? d.id);
    const g = groups.get(k);
    if (g) g.n++; else groups.set(k, { verdict: d.verdict ?? 'open', why: d.why ?? 'not yet adjudicated', label: d.label, n: 1, example: d.id });
  }
  const order = ['corpus-error', 'corpus-outdated', 'beyond-spec', 'deliberate', 'not-implemented', 'open'];
  const md = [
    '# Conformance',
    '',
    '<!-- Generated by `npm run conformance`. Do not edit by hand. -->',
    '',
    'biolint is scored against test corpora maintained by other projects. They are not vendored: `node scripts/corpora.ts` fetches them at pinned commits.',
    '',
    ...CORPORA.map((c) => `- **${c.name}**: ${c.repo.replace(/\.git$/, '')} at \`${c.commit.slice(0, 12)}\``),
    '',
    'Each corpus file is labelled valid or invalid by its authors. biolint is run in the strict profile, and a file counts as rejected when at least one error is reported.',
    '',
    table,
    '',
    ...Object.values(modules).flatMap((m) => m.notes ?? []),
    '',
    '## Disagreements',
    '',
    `Every one of the ${disagreements.length} disagreements is classified:`,
    '',
    '| Verdict | Files | Meaning |',
    '|---|---:|---|',
    `| corpus-error | ${byVerdict['corpus-error'] ?? 0} | the label contradicts the specification, or the file has a second, unintended defect |`,
    `| corpus-outdated | ${byVerdict['corpus-outdated'] ?? 0} | the label follows an earlier revision of the specification |`,
    `| beyond-spec | ${byVerdict['beyond-spec'] ?? 0} | the corpus enforces a convention of its own validator that the specification does not state |`,
    `| deliberate | ${byVerdict['deliberate'] ?? 0} | biolint knowingly differs |`,
    `| not-implemented | ${byVerdict['not-implemented'] ?? 0} | a real requirement that biolint does not check yet |`,
    `| open | ${open} | not yet explained |`,
    '',
    '| Verdict | Corpus label | Files | Reason | Example |',
    '|---|---|---:|---|---|',
    ...[...groups.values()].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || b.n - a.n).map((g) => `| ${g.verdict} | ${g.label} | ${g.n} | ${g.why.replace(/\|/g, '\\|')} | \`${g.example.split('/').slice(-3).join('/')}\` |`),
    '',
    'These classifications are the judgement of the biolint authors, not of the corpus maintainers. The full list is in `conformance/results.json`.',
    '',
  ].join('\n');
  writeFileSync(join(import.meta.dirname, '..', 'docs', 'CONFORMANCE.md'), md);
  if (args.includes('--check') && open > 0) { console.error(`${open} unexplained disagreement(s)`); process.exit(1); }
}
