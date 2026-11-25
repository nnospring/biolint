import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bgzip } from './helpers/bgzf.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const dir = mkdtempSync(join(tmpdir(), 'biolint-cli-'));
const GOOD = '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1\t100\t.\tA\tT\t.\t.\t.\n';
const BAD = GOOD.replace('100', '1e+05');
const WARN = GOOD.replace('.\t.\t.\n', '.\tq10\t.\n');
const file = (name: string, content: string | Uint8Array) => { const p = join(dir, name); writeFileSync(p, content); return p; };
const run = (args: string[], input?: string | Uint8Array) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined } as NodeJS.ProcessEnv });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('exit status: 0 clean, 1 errors, 2 missing file; warnings do not fail unless --max-warnings', () => {
  assert.equal(run([file('good.vcf', GOOD)]).code, 0);
  assert.equal(run([file('bad.vcf', BAD)]).code, 1);
  const missing = run([join(dir, 'nope.vcf')]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no such file/);
  const w = file('warn.vcf', WARN);
  assert.equal(run([w]).code, 0);
  assert.equal(run([w, '--max-warnings', '0']).code, 1);
  assert.equal(run(['--bogus']).code, 2);
  assert.equal(run(['--type', 'nope', w]).code, 2);
});

test('output is uncoloured when not writing to a terminal, coloured on request', () => {
  const p = file('bad2.vcf', BAD);
  assert.ok(!run([p]).out.includes('\x1b['));
  assert.ok(run([p, '--color']).out.includes('\x1b['));
});

test('pretty output shows location, excerpt, caret and help', () => {
  const { out } = run([file('bad3.vcf', BAD)]);
  assert.match(out, /error\[VCF205\]: POS `1e\+05` is not a valid position/);
  assert.match(out, /--> .*bad3\.vcf:3:3/);
  assert.match(out, /3 \| 1→1e\+05→/);
  assert.match(out, /\n {2}\| {3}\^{5}\n/);
  assert.match(out, /help: scientific notation/);
});

test('compact, json, sarif and github formats', () => {
  const p = file('bad4.vcf', BAD);
  assert.match(run([p, '-f', 'compact']).out, /bad4\.vcf:3:3: error\[VCF205\] /);
  const json = JSON.parse(run([p, '-f', 'json']).out);
  assert.equal(json.schema, 1);
  assert.equal(json.results[0].diagnostics[0].code, 'VCF205');
  assert.deepEqual([json.results[0].diagnostics[0].line, json.results[0].diagnostics[0].column, json.results[0].diagnostics[0].endColumn], [3, 3, 8]);
  const sarif = JSON.parse(run([p, '-f', 'sarif']).out);
  assert.equal(sarif.version, '2.1.0');
  const res = sarif.runs[0].results[0];
  assert.equal(res.ruleId, 'VCF205');
  assert.deepEqual(res.locations[0].physicalLocation.region, { startLine: 3, startColumn: 3, endColumn: 8 });
  assert.equal(sarif.runs[0].columnKind, 'unicodeCodePoints');
  assert.ok(sarif.runs[0].tool.driver.rules.some((r: { id: string }) => r.id === 'VCF205'));
  const gh = run([p, '-f', 'github']).out;
  assert.match(gh, /^::error file=.*bad4\.vcf,line=3,col=3,endColumn=8,title=VCF205 pos-invalid::POS `1e\+05`/m);
});

test('standard input, gzip and BGZF inputs', () => {
  assert.match(run(['--type', 'vcf', '-'], BAD).out, /<stdin>:3:3/);
  assert.equal(run([file('bad.vcf.gz', gzipSync(BAD)), '-f', 'compact']).code, 1);
  const bg = run([file('good.vcf.bgz', bgzip(Buffer.from(GOOD)))]);
  assert.equal(bg.code, 0);
  assert.match(bg.out, /no problems/);
  assert.match(run([file('noeof.vcf.gz', bgzip(Buffer.from(GOOD), { eof: false })), '-f', 'compact']).out, /GZ002/);
  assert.match(run([file('plain.vcf.gz', gzipSync(GOOD)), '-f', 'compact']).out, /info\[GZ003\]/);
  const cut = gzipSync(Buffer.from(GOOD.repeat(200)));
  const t = run([file('cut.vcf.gz', cut.subarray(0, cut.length - 20)), '-f', 'compact']);
  assert.equal(t.code, 1);
  assert.match(t.out, /error\[GZ001\]/);
});

test('--fix repairs in place and on standard input', () => {
  const broken = '﻿' + GOOD.replace(/\n/g, '\r\n');
  const p = file('fixme.vcf', broken);
  const r = run([p, '--fix']);
  assert.equal(r.code, 0);
  assert.match(r.err, /repaired 2 problems/);
  assert.equal(readFileSync(p, 'utf8'), GOOD);
  const s = run(['--fix', '--type', 'vcf', '-'], broken);
  assert.equal(s.out, GOOD);
  assert.equal(run(['--fix', file('fix.vcf.gz', gzipSync(broken))]).code, 2);
});

test('--explain, --list-rules, --list-formats, --version, --help', () => {
  const e = run(['--explain', 'VCF205']);
  assert.equal(e.code, 0);
  assert.match(e.out, /VCF205 {2}pos-invalid/);
  assert.match(e.out, /error\[VCF205\]/);
  assert.equal(run(['--explain', 'pos-invalid']).code, 0);
  assert.equal(run(['--explain', 'NOPE999']).code, 2);
  assert.match(run(['--list-rules']).out, /VCF205 +pos-invalid +error/);
  assert.match(run(['--list-formats']).out, /^vcf +Variant Call Format/m);
  assert.match(run(['--version']).out, /^\d+\.\d+\.\d+\n$/);
  assert.match(run(['--help']).out, /Exit status/);
});

test('--quiet, --select, --ignore, --strict, --max-per-rule', () => {
  const p = file('mixed.vcf', WARN.replace('100', '1e+05'));
  assert.match(run([p, '-f', 'compact']).out, /VCF217/);
  assert.ok(!run([p, '-f', 'compact', '-q']).out.includes('VCF217'));
  assert.ok(!run([p, '-f', 'compact', '--ignore', 'VCF217,VCF205']).out.includes('VCF2'));
  assert.equal(run([p, '--select', 'VCF217']).code, 0);
  const strictOnly = file('unsorted.vcf', GOOD + '1\t50\t.\tA\tT\t.\t.\t.\n');
  assert.equal(run([strictOnly]).code, 0);
  assert.equal(run([strictOnly, '--strict']).code, 1);
  const many = file('many.vcf', GOOD + Array.from({ length: 30 }, (_, i) => `1\t${200 + i}\t.\tA\tT\tbad\t.\t.\n`).join(''));
  assert.equal(run([many, '-f', 'compact']).out.trim().split('\n').length, 5);
  assert.equal(run([many, '-f', 'compact', '--max-per-rule', '0']).out.trim().split('\n').length, 30);
  assert.match(run([many]).out, /VCF215 {2}30 occurrences, 5 shown/);
});

test('version in the source matches package.json', async () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const { VERSION } = await import('../src/version.ts');
  assert.equal(VERSION, pkg.version);
});
