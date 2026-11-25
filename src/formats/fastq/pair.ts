import type { Diagnostic, LintResult, RuleMeta } from '../../core/types.ts';
import { plural } from '../../core/util.ts';
import { NAME_BLOCK } from './index.ts';
import { Q } from './rules.ts';

export type { Diagnostic, LintResult } from '../../core/types.ts';

/**
 * Compare the two files of a paired-end run using the statistics the FASTQ validator publishes
 * (`reads`, `nameDigest`, `nameCheckpoints`), without reading either file again.
 *
 * Returns file-level diagnostics (line 0) that belong to the second file: a different number of reads (FQ020),
 * and read names that are not the same in the same order (FQ021), with the block of reads where they first differ.
 * Names are compared after removing a trailing `/1` or `/2` and everything from the first whitespace.
 * Returns nothing when either result is not a FASTQ result with statistics (for example an empty file).
 */
export function comparePair(first: LintResult, second: LintResult): Diagnostic[] {
  const a = pairStats(first), b = pairStats(second);
  if (!a || !b) return [];
  const out: Diagnostic[] = [];
  const mate = `\`${baseName(first.filename)}\``;
  const fmt = (n: number) => n.toLocaleString('en-US');

  // The running digest after every full block that both files have.
  const common = Math.min(a.blocks.length, b.blocks.length);
  let firstDiff = -1;
  for (let i = 0; i < common; i++) if (a.blocks[i] !== b.blocks[i]) { firstDiff = i; break; }

  if (a.reads !== b.reads) {
    const fewer = Math.min(a.reads, b.reads);
    out.push(diagnostic(Q.pairCountMismatch, `this file has ${plural(b.reads, 'read')} but its mate ${mate} has ${fmt(a.reads)}`,
      firstDiff < 0 && common > 0
        ? `the names agree for the first ${fmt(common * NAME_BLOCK)} reads, so the file with ${fmt(fewer)} reads is probably truncated: transfer or generate it again`
        : 'one file was truncated, or the two were filtered separately; re-pair with `seqkit pair -1 R1.fq -2 R2.fq` or BBMap `repair.sh in=R1.fq in2=R2.fq out=fixed_1.fq out2=fixed_2.fq outs=singletons.fq`'));
  }
  if (firstDiff < 0 && a.reads === b.reads && a.digest !== b.digest) firstDiff = common; // in the last, partial block
  if (firstDiff >= 0) {
    const from = firstDiff * NAME_BLOCK + 1;
    const to = Math.min((firstDiff + 1) * NAME_BLOCK, Math.min(a.reads, b.reads));
    out.push(diagnostic(Q.pairNameMismatch,
      `read names differ from those of the mate ${mate}: the first difference is among reads ${fmt(from)}-${fmt(to)}`,
      `the first ${fmt(from - 1)} reads have the same names in both files; look at the names of reads ${fmt(from)}-${fmt(to)} in each ` +
      `(\`awk 'NR%4==1' file.fq | sed -n '${from},${to}p'\`). Re-pair with \`seqkit pair -1 R1.fq -2 R2.fq\` or BBMap \`repair.sh\``));
  }
  return out;
}

interface PairStats { reads: number; digest: string; blocks: string[] }

function pairStats(r: LintResult): PairStats | null {
  const { reads, nameDigest, nameCheckpoints } = r.stats;
  if (r.format !== 'fastq' || typeof reads !== 'number' || typeof nameDigest !== 'string' || typeof nameCheckpoints !== 'string') return null;
  const blocks: string[] = [];
  for (let i = 0; i + 16 <= nameCheckpoints.length; i += 16) blocks.push(nameCheckpoints.slice(i, i + 16));
  return { reads, digest: nameDigest, blocks };
}

function diagnostic(rule: RuleMeta, message: string, hint: string): Diagnostic {
  // A LintResult does not record the profile it was produced with, so the rule's default level is used.
  const severity = rule.level === 'off' ? 'error' : rule.level;
  const d: Diagnostic = { code: rule.code, name: rule.name, severity, message, line: 0, column: 0, endColumn: 0, byteColumn: 0, hint };
  if (rule.spec) d.spec = rule.spec;
  return d;
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}
