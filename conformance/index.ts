import type { Adjudication, Corpus, FormatConformance, Suite } from './types.ts';
import * as vcf from './vcf.ts';
import * as fasta from './fasta.ts';
import * as fastq from './fastq.ts';
import * as gff3 from './gff3.ts';
import * as gtf from './gtf.ts';
import * as bed from './bed.ts';
import * as sam from './sam.ts';

/** One module per format. */
export const modules: Record<string, FormatConformance> = { vcf, sam, fastq, fasta, gff3, gtf, bed };

export const corpora: Corpus[] = (() => {
  const seen = new Map<string, Corpus>();
  for (const m of Object.values(modules)) for (const c of m.corpora) {
    const prev = seen.get(c.name);
    if (!prev) seen.set(c.name, { ...c, paths: [...c.paths] });
    else {
      if (prev.commit !== c.commit) throw new Error(`corpus ${c.name} is pinned to two different commits`);
      for (const p of c.paths) if (!prev.paths.includes(p)) prev.paths.push(p);
    }
  }
  return [...seen.values()];
})();
export const suites: Suite[] = Object.values(modules).flatMap((m) => m.suites);
export const adjudicationsFor = (format: string): Adjudication[] => modules[format]?.adjudications ?? [];
