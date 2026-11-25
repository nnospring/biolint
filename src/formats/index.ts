import type { FormatDef, RuleMeta } from '../core/types.ts';
import { T } from './text.ts';
import { vcf } from './vcf/index.ts';
import { fasta } from './fasta/index.ts';
import { fastq } from './fastq/index.ts';
import { gff3 } from './gff3/index.ts';
import { gtf } from './gtf/index.ts';
import { bed } from './bed/index.ts';
import { sam } from './sam/index.ts';

/** Every supported format. Order matters only for ties in content detection. */
export const formats: FormatDef[] = [vcf, sam, fastq, fasta, gff3, gtf, bed];

/** Rules that are not specific to one format. */
export const textRules: RuleMeta[] = Object.values(T);

/** All rules, generic ones first. */
export function allRules(): RuleMeta[] {
  return [...textRules, ...formats.flatMap((f) => f.rules)];
}

/** Look a rule up by code (`VCF102`) or name (`info-type`), case-insensitively. */
export function findRule(codeOrName: string): RuleMeta | undefined {
  const q = codeOrName.toLowerCase();
  return allRules().find((r) => r.code.toLowerCase() === q || r.name === q);
}
