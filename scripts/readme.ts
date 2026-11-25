// Rewrites the generated blocks in README.md and README.zh-CN.md from the rule catalogue and the committed reports,
// so that no number in the README is typed by hand. Usage: node scripts/readme.ts [--check]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allRules, formats, lintText, renderPretty } from '../src/index.ts';

const root = join(import.meta.dirname, '..');
const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const conf = existsSync(join(root, 'conformance/results.json')) ? read('conformance/results.json') : { rows: [], disagreements: [] };
const real = existsSync(join(root, 'conformance/holdout-first-run.json')) ? read('conformance/holdout-first-run.json') : { rows: {}, failures: [] };
const notes = existsSync(join(root, 'conformance/realworld-notes.json')) ? read('conformance/realworld-notes.json') as { path: string; kind: string }[] : [];
const falsePositives = (id: string) => (real.failures as { path: string; set: string; format: string }[]).filter((f) => f.set === 'holdout' && f.format === id && notes.find((n) => f.path.includes(n.path))?.kind === 'false-positive').length;
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + '%' : '–');

interface Row { files: number; agree: number }
const byFormat = (id: string): Row => (conf.rows as { format: string; files: number; agree: number }[]).filter((r) => r.format === id).reduce((t, r) => ({ files: t.files + r.files, agree: t.agree + r.agree }), { files: 0, agree: 0 });
const realRow = (id: string, set: string) => real.rows[`${id} (${set})`] as { files: number; clean: number; withWarnings: number; withErrors: number } | undefined;

function table(zh: boolean): string {
  const head = zh
    ? '| 格式 | 规则数 | 第三方语料：严格档与标注一致 | 留出的真实文件：盲测时被误报为错误 |\n|---|---:|---:|---:|'
    : '| Format | Rules | Third-party corpus: strict profile agrees with the label | Held-out real files: wrongly flagged as errors on the blind run |\n|---|---:|---:|---:|';
  const lines = [head];
  for (const f of formats) {
    const n = f.rules.length;
    if (!n) continue;
    const c = byFormat(f.id);
    const h = realRow(f.id, 'holdout');
    const corpus = c.files ? `${c.agree} / ${c.files} (${pct(c.agree, c.files)})` : zh ? '无带标注的语料' : 'no labelled corpus';
    const rw = h ? `${falsePositives(f.id)} / ${h.files}` : zh ? '未评分' : 'not scored';
    lines.push(`| ${f.name} | ${n} | ${corpus} | ${rw} |`);
  }
  const t = allRules().filter((r) => r.format === 'text').length;
  lines.push(zh ? `| 通用文本与压缩容器 | ${t} | | |` : `| Any text format, gzip/BGZF | ${t} | | |`);
  const d = conf.disagreements as { verdict: string | null }[];
  const count = (v: string) => d.filter((x) => x.verdict === v).length;
  const tail = zh
    ? `\n共 ${allRules().length} 条规则。与语料的 ${d.length} 处分歧全部逐条归类：语料自身有误 ${count('corpus-error')}，语料落后于规范 ${count('corpus-outdated')}，语料超出规范 ${count('beyond-spec')}，有意不同 ${count('deliberate')}，**尚未实现 ${count('not-implemented')}**。详见 [docs/CONFORMANCE.md](docs/CONFORMANCE.md)。真实文件的盲测结果（含两处误报及其修复）见 [docs/REALWORLD.md](docs/REALWORLD.md)。`
    : `\n${allRules().length} rules in total. All ${d.length} disagreements with the corpora are classified: corpus error ${count('corpus-error')}, corpus outdated ${count('corpus-outdated')}, beyond the specification ${count('beyond-spec')}, deliberate ${count('deliberate')}, **not implemented yet ${count('not-implemented')}**. See [docs/CONFORMANCE.md](docs/CONFORMANCE.md). The blind run on real files, including the two false positives it exposed and their fixes, is in [docs/REALWORLD.md](docs/REALWORLD.md).`;
  return lines.join('\n') + '\n' + tail;
}

function demo(): string {
  const text = readFileSync(join(root, 'examples/broken.vcf'), 'utf8');
  const res = lintText(text, { filename: 'examples/broken.vcf', select: ['VCF010', 'VCF205', 'VCF305', 'VCF405', 'VCF210', 'VCF204'] });
  return '```text\n$ biolint examples/broken.vcf\n\n' + renderPretty(res, { color: false }) + '\n```';
}
const block = (text: string, name: string, body: string) => {
  const re = new RegExp(`(<!-- ${name}:start -->\\n)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(text)) { console.error(`${name} markers not found`); process.exit(1); }
  return text.replace(re, (_m, a: string, b: string) => `${a}${body}\n${b}`);
};

let stale = false;
for (const [file, zh] of [['README.md', false], ['README.zh-CN.md', true]] as const) {
  const p = join(root, file);
  const old = readFileSync(p, 'utf8');
  const next = block(block(old, 'status', table(zh)), 'demo', demo());
  if (next !== old) { stale = true; if (!process.argv.includes('--check')) writeFileSync(p, next); }
}
if (process.argv.includes('--check') && stale) { console.error('README status blocks are out of date: run `node scripts/readme.ts`'); process.exit(1); }
console.log(stale ? 'README updated' : 'README up to date');
