#!/usr/bin/env node
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { applyFixes } from './core/fix.ts';
import { inspectGzip } from './core/gzip.ts';
import type { LintOptions, LintResult, RuleMeta } from './core/types.ts';
import { allRules, findRule, formats } from './formats/index.ts';
import { lintText } from './index.ts';
import { comparePair } from './formats/fastq/pair.ts';
import { lintFile } from './node.ts';
import { renderGithub, renderJson, renderSarif } from './render/machine.ts';
import { renderCompact, renderPretty } from './render/pretty.ts';
import { HOMEPAGE, VERSION } from './version.ts';

const HELP = `biolint ${VERSION}: compiler-grade diagnostics for bioinformatics file formats

Usage
  biolint [options] <file ...>        check files (.gz and .bgz are read directly)
  biolint [options] -                 check standard input (give --type)
  biolint --explain <rule>            describe a rule, with examples
  biolint --list-rules [--type f]     list every rule

Options
  -t, --type <format>     treat input as this format instead of detecting it
                          (${formats.map((f) => f.id).join(', ')})
      --strict            follow each specification to the letter
                          (default: report as errors only what breaks mainstream tools)
  -f, --format <style>    pretty (default), compact, json, sarif, github
      --select <rules>    only report these rules; comma-separated codes, names or prefixes (e.g. VCF3)
      --ignore <rules>    never report these rules
      --max-per-rule <n>  print at most n occurrences of each rule per file (default 5, 0 = all)
      --max-warnings <n>  exit with status 1 when there are more than n warnings
  -o, --option <f.k=v>    format-specific option, e.g. fasta.alphabet=protein (repeatable)
  -q, --quiet             print errors only
      --paired            the files are paired-end FASTQ, given as R1 R2 [R1 R2 ...]:
                          also check that each pair has the same reads in the same order
      --fix               repair what can be repaired mechanically, in place
                          (with "-", the repaired text goes to standard output)
      --no-context        do not print the offending line
      --color, --no-color force or disable colour (default: when writing to a terminal)
      --list-formats      list supported formats
  -v, --version
  -h, --help

Exit status
  0  no errors        1  errors found (or --max-warnings exceeded)        2  usage or I/O problem
`;

function fail(message: string): never {
  process.stderr.write(`biolint: ${message}\n`);
  process.exit(2);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        type: { type: 'string', short: 't' },
        strict: { type: 'boolean' },
        format: { type: 'string', short: 'f' },
        select: { type: 'string', multiple: true },
        ignore: { type: 'string', multiple: true },
        'max-per-rule': { type: 'string' },
        'max-warnings': { type: 'string' },
        option: { type: 'string', short: 'o', multiple: true },
        quiet: { type: 'boolean', short: 'q' },
        fix: { type: 'boolean' },
        paired: { type: 'boolean' },
        'no-context': { type: 'boolean' },
        color: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        explain: { type: 'string' },
        'list-rules': { type: 'boolean' },
        'list-formats': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\nTry \`biolint --help\`.`);
  }
}

function levels(r: RuleMeta): string {
  const strict = r.strict ?? r.level;
  return strict === r.level ? r.level : `${r.level} (strict: ${strict})`;
}

function explain(name: string, color: boolean): string {
  const r = findRule(name);
  if (!r) fail(`no rule called \`${name}\`. Run \`biolint --list-rules\` to see them all.`);
  const out: string[] = [];
  out.push(`${r.code}  ${r.name}`, '', r.title, '');
  out.push(`Format   ${r.format}`, `Level    ${levels(r)}`);
  if (r.spec) out.push(`Spec     ${r.spec}`);
  if (r.fixable) out.push('Fixable  yes (--fix)');
  if (HOMEPAGE) out.push(`Docs     ${HOMEPAGE}/blob/main/docs/rules/${r.code}.md`);
  out.push('', r.explanation.replace(/`/g, ''), '');
  const bad = r.examples?.bad?.[0];
  if (bad) {
    out.push('Example', '');
    const format = r.format === 'text' ? bad.format ?? 'fasta' : r.format;
    const result = lintText(bad.text, { filename: `example.${format}`, format: formats.some((f) => f.id === format) ? format : undefined, profile: bad.profile ?? (r.level === 'off' ? 'strict' : 'default'), select: [r.code], ...(bad.options ? { formatOptions: { [format]: bad.options } } : {}) } as LintOptions);
    out.push(renderPretty(result, { color }).split('\n').slice(0, -1).join('\n'));
  }
  return out.join('\n');
}

function listRules(type: string | undefined): string {
  const rules = allRules().filter((r) => !type || r.format === type || r.format === 'text');
  const w = Math.max(...rules.map((r) => r.name.length));
  return rules.map((r) => `${r.code.padEnd(7)} ${r.name.padEnd(w)}  ${levels(r).padEnd(24)} ${r.title}`).join('\n');
}

async function main(): Promise<number> {
  const { values, positionals } = parse();
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (values.version) { process.stdout.write(VERSION + '\n'); return 0; }
  const color = values['no-color'] ? false : values.color ? true : !!process.stdout.isTTY && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb';
  if (values.explain) { process.stdout.write(explain(values.explain, color) + '\n'); return 0; }
  if (values['list-formats']) {
    process.stdout.write(formats.map((f) => `${f.id.padEnd(8)} ${f.description}  [${f.extensions.join(' ')}]`).join('\n') + '\n');
    return 0;
  }
  if (values.type && !formats.some((f) => f.id === values.type)) fail(`unknown format \`${values.type}\`. Supported: ${formats.map((f) => f.id).join(', ')}.`);
  if (values['list-rules']) { process.stdout.write(listRules(values.type) + '\n'); return 0; }
  if (positionals.length === 0) {
    if (process.stdin.isTTY) { process.stderr.write(HELP); return 2; }
    positionals.push('-');
  }
  const style = values.format ?? 'pretty';
  if (!['pretty', 'compact', 'json', 'sarif', 'github'].includes(style)) fail(`unknown output format \`${style}\`. Use pretty, compact, json, sarif or github.`);
  const int = (name: 'max-per-rule' | 'max-warnings'): number | undefined => {
    const v = values[name];
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) fail(`--${name} needs a non-negative integer, got \`${v}\`.`);
    return Number(v);
  };
  const list = (v: string[] | undefined) => v?.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const maxWarnings = int('max-warnings');
  const base: LintOptions = { profile: values.strict ? 'strict' : 'default' };
  if (values.type) base.format = values.type;
  const select = list(values.select), ignore = list(values.ignore);
  if (select) base.select = select;
  if (ignore) base.ignore = ignore;
  const mpr = int('max-per-rule');
  if (mpr !== undefined) base.maxPerRule = mpr;
  for (const o of values.option ?? []) {
    const m = /^([a-z0-9]+)\.([A-Za-z0-9_-]+)=(.*)$/.exec(o);
    if (!m || !formats.some((f) => f.id === m[1])) fail(`--option expects <format>.<key>=<value> with a known format, got \`${o}\`.`);
    const v = m[3]!;
    ((base.formatOptions ??= {})[m[1]!] ??= {})[m[2]!] = v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }

  if (values.paired && (positionals.length % 2 !== 0 || positionals.includes('-'))) fail('--paired needs an even number of files, given as R1 R2 [R1 R2 ...].');
  const results: LintResult[] = [];
  let ioFailed = false;
  const report = values.fix && positionals.includes('-') ? process.stderr : process.stdout;

  for (const path of positionals) {
    try {
      let result: LintResult;
      if (values.fix) result = fixFile(path, base);
      else result = await lintFile(path, base);
      if (values.paired && results.length % 2 === 1) {
        for (const d of comparePair(results[results.length - 1]!, result)) {
          result.diagnostics.push(d);
          result.counts[d.severity]++;
          const r = (result.byRule[d.code] ??= { count: 0, shown: 0, severity: d.severity, fixable: false });
          r.count++; r.shown++;
        }
      }
      if (values.quiet) result.diagnostics = result.diagnostics.filter((d) => d.severity === 'error');
      results.push(result);
      if (style === 'pretty') report.write(renderPretty(result, { color, context: !values['no-context'] }) + '\n' + (positionals.length > 1 ? '\n' : ''));
      else if (style === 'compact') { const s = renderCompact(result); if (s) report.write(s + '\n'); }
    } catch (e) {
      ioFailed = true;
      if (values.paired) results.push({ filename: path, format: 'unknown', formatSource: 'none', diagnostics: [], counts: { error: 0, warning: 0, info: 0 }, byRule: {}, stats: {}, lines: 0, bytes: 0 });
      const err = e as NodeJS.ErrnoException;
      const why = err.code === 'ENOENT' ? 'no such file' : err.code === 'EISDIR' ? 'is a directory' : err.code === 'EACCES' ? 'permission denied' : err.message;
      process.stderr.write(`biolint: ${path}: ${why}\n`);
    }
  }

  if (style === 'json') report.write(renderJson(results) + '\n');
  else if (style === 'sarif') report.write(renderSarif(results, allRules()) + '\n');
  else if (style === 'github') { const s = renderGithub(results); if (s) report.write(s + '\n'); }

  const errors = results.reduce((n, r) => n + r.counts.error, 0);
  const warnings = results.reduce((n, r) => n + r.counts.warning, 0);
  if (style === 'pretty' && results.length > 1) {
    const clean = results.filter((r) => r.counts.error === 0 && r.counts.warning === 0).length;
    report.write(`${results.length} files checked: ${errors.toLocaleString('en-US')} error${errors === 1 ? '' : 's'}, ${warnings.toLocaleString('en-US')} warning${warnings === 1 ? '' : 's'}, ${clean} clean\n`);
  }
  if (style === 'pretty' && !values.fix) {
    const fixable = results.reduce((n, r) => n + Object.values(r.byRule).filter((x) => x.fixable).reduce((m, x) => m + x.count, 0), 0);
    if (fixable) report.write(`${fixable.toLocaleString('en-US')} problem${fixable === 1 ? '' : 's'} can be repaired with --fix. Explain any rule with: biolint --explain <CODE>\n`);
    else if (errors + warnings > 0) report.write('Explain any rule with: biolint --explain <CODE>\n');
  }
  if (ioFailed) return 2;
  if (errors > 0) return 1;
  if (maxWarnings !== undefined && warnings > maxWarnings) return 1;
  return 0;
}

/** Lint, repair in memory, write back, and return the result of linting the repaired content. */
function fixFile(path: string, base: LintOptions): LintResult {
  const stdin = path === '-';
  const filename = stdin ? '<stdin>' : path;
  if (!stdin && statSync(path).size > 1 << 30) throw new Error('too large to fix in memory (over 1 GiB); fix a decompressed stream instead: `biolint --fix - < in > out`');
  const content = stdin ? readFileSync(0) : readFileSync(path);
  if (inspectGzip(content).gzip) throw new Error('cannot fix a compressed file in place; decompress it first, or pipe it: `zcat file.gz | biolint --fix --type <format> - > fixed`');
  const first = lintText(content, { ...base, filename, maxPerRule: 0 });
  const outcome = applyFixes(content, first.diagnostics);
  if (stdin) process.stdout.write(outcome.output);
  else if (outcome.applied > 0) {
    const tmp = `${path}.biolint-tmp-${process.pid}`;
    writeFileSync(tmp, outcome.output, { mode: statSync(path).mode });
    renameSync(tmp, path);
  }
  const after = lintText(outcome.output, { ...base, filename });
  after.stats['fixed'] = outcome.applied;
  if (outcome.applied > 0) process.stderr.write(`biolint: ${filename}: repaired ${outcome.applied.toLocaleString('en-US')} problem${outcome.applied === 1 ? '' : 's'}\n`);
  return after;
}

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`biolint: internal error: ${(e as Error).stack ?? e}\n`); process.exitCode = 2; });
