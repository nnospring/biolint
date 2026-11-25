import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintText } from '../src/index.ts';
import { GOOD_VCF_EXAMPLES } from '../src/formats/vcf/rules.ts';

test('valid VCF examples produce no diagnostics, in both profiles', () => {
  for (const text of GOOD_VCF_EXAMPLES) {
    for (const profile of ['default', 'strict'] as const) {
      const r = lintText(text, { filename: 'ok.vcf', profile });
      assert.deepEqual(r.diagnostics.map((d) => `${d.code}@${d.line}:${d.column} ${d.message}`), [], profile);
      assert.equal(r.format, 'vcf');
    }
  }
});

test('positions are 1-based and point at the offending text', () => {
  const text = '##fileformat=VCFv4.3\n##INFO=<ID=DP,Number=1,Type=Int,Description="Depth">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1\t100\t.\tA\tT\t.\t.\tDP=3\n';
  const r = lintText(text, { filename: 'a.vcf' });
  const d = r.diagnostics.find((x) => x.code === 'VCF010')!;
  assert.equal(d.line, 2);
  assert.equal(text.split('\n')[1]!.slice(d.column - 1, d.endColumn - 1), 'Int');
  assert.match(d.hint!, /Integer/);
});
