import type { Example, Level, RuleMeta } from './types.ts';

type RuleInput = {
  code: string;
  title: string;
  level: Level;
  strict?: Level;
  explanation: string;
  spec?: string;
  fixable?: boolean;
  maxShown?: number;
  bad?: (string | Example)[];
  good?: (string | Example)[];
};

const camelToKebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const toExample = (e: string | Example): Example => (typeof e === 'string' ? { text: e } : e);

/**
 * Declare the rules of one format. Keys are camelCase rule names; the kebab-case form becomes the public name.
 *
 *   const R = defineRules('vcf', { infoTypeInvalid: { code: 'VCF102', ... } });
 *   ctx.report(R.infoTypeInvalid, ...)
 */
export function defineRules<K extends string>(format: string, defs: Record<K, RuleInput>): Record<K, RuleMeta> {
  const out = {} as Record<K, RuleMeta>;
  for (const key of Object.keys(defs) as K[]) {
    const d = defs[key];
    const meta: RuleMeta = {
      code: d.code,
      name: camelToKebab(key),
      format,
      title: d.title,
      level: d.level,
      explanation: d.explanation,
    };
    if (d.strict !== undefined) meta.strict = d.strict;
    if (d.spec !== undefined) meta.spec = d.spec;
    if (d.fixable) meta.fixable = true;
    if (d.maxShown !== undefined) meta.maxShown = d.maxShown;
    if (d.bad || d.good) {
      meta.examples = {};
      if (d.bad) meta.examples.bad = d.bad.map(toExample);
      if (d.good) meta.examples.good = d.good.map(toExample);
    }
    out[key] = meta;
  }
  return out;
}

/** Write example files with visible structure: `→` becomes a tab, a leading newline and common indent are removed. */
export function ex(strings: TemplateStringsArray, ...values: unknown[]): string {
  let s = String.raw({ raw: strings }, ...values);
  if (s.startsWith('\n')) s = s.slice(1);
  const lines = s.split('\n');
  if (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).replace(/→/g, '\t')).join('\n') + '\n';
}
