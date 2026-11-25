// Every rule documents itself with examples; this file turns those examples into tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allRules, formats, lintText } from '../src/index.ts';
import type { RuleMeta } from '../src/index.ts';

const fmtOf = (r: RuleMeta, e?: { format?: string }) => (formats.some((f) => f.id === r.format) ? r.format : e?.format ?? 'fasta');
const has = (id: string) => formats.some((f) => f.id === id);

test('rule codes and names are unique and well-formed', () => {
  const codes = new Set<string>(), names = new Set<string>();
  for (const r of allRules()) {
    assert.match(r.code, /^[A-Z]{2,5}\d{3}$/, r.code);
    assert.match(r.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, r.name);
    assert.ok(!codes.has(r.code), `duplicate code ${r.code}`);
    assert.ok(!names.has(`${r.format}/${r.name}`), `duplicate name ${r.name}`);
    codes.add(r.code); names.add(`${r.format}/${r.name}`);
    assert.ok(r.title.length > 8 && !r.title.endsWith('.'), `${r.code}: title`);
    assert.ok(r.explanation.length > 40, `${r.code}: explanation`);
  }
});

for (const rule of allRules()) {
  if (!has(fmtOf(rule))) continue;
  for (const [i, example] of (rule.examples?.bad ?? []).entries()) {
    test(`${rule.code} ${rule.name}: bad example ${i + 1} is reported`, () => {
      const format = fmtOf(rule, example);
      const res = lintText(example.text, { format, filename: `example.${format}`, profile: example.profile ?? 'default', maxPerRule: 0, ...(example.options ? { formatOptions: { [format]: example.options } } : {}) });
      const hits = res.diagnostics.filter((d) => d.code === rule.code);
      assert.ok(hits.length > 0, `expected ${rule.code}, got: ${res.diagnostics.map((d) => `${d.code}@${d.line}:${d.column} ${d.message}`).join(' | ') || 'nothing'}`);
      for (const d of hits) {
        assert.ok(d.message.length > 5 && !/undefined|NaN|\[object/.test(d.message), `message: ${d.message}`);
        if (d.column > 0) assert.ok(d.line > 0 && d.endColumn >= d.column, `columns ${d.column}-${d.endColumn}`);
      }
      // A focused example should not trip unrelated errors.
      const others = res.diagnostics.filter((d) => d.code !== rule.code && d.severity === 'error');
      assert.deepEqual(others.map((d) => `${d.code} ${d.message}`), [], 'unrelated errors in a bad example');
    });
  }
  for (const [i, example] of (rule.examples?.good ?? []).entries()) {
    test(`${rule.code} ${rule.name}: good example ${i + 1} is clean`, () => {
      const format = fmtOf(rule, example);
      const res = lintText(example.text, { format, filename: `example.${format}`, profile: example.profile ?? 'default', maxPerRule: 0, ...(example.options ? { formatOptions: { [format]: example.options } } : {}) });
      assert.deepEqual(res.diagnostics.map((d) => `${d.code}@${d.line} ${d.message}`), []);
    });
  }
}

test('every format rule that is on by default has a bad example', () => {
  const missing = allRules().filter((r) => r.format !== 'text' && !(r.examples?.bad?.length)).map((r) => r.code);
  assert.deepEqual(missing, []);
});
