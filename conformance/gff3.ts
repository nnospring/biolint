// GFF3 conformance: the corpora it is scored against, and an explanation for every disagreement.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adjudication, Corpus, Suite } from './types.ts';

export const corpora: Corpus[] = [
  // Specimens collected by the BioJulia project; GFF3/index.yml marks each file `valid: true|false`.
  { name: 'BioFmtSpecimens', repo: 'https://github.com/BioJulia/BioFmtSpecimens.git', commit: 'a88ddc9ceca014f47716406f0ede706a70bbbe49', paths: ['GFF3'],
    license: 'mixed: each specimen keeps the licence of its origin (LICENSE.md; the GFF3 specimens come mostly from gff3-pltools, MIT)' },
  // The test data of GenomeTools, whose `gt gff3` parser is the strictest GFF3 reader in common use.
  { name: 'genometools', repo: 'https://github.com/genometools/genometools.git', commit: '5cd9b0fe1e78449011b15a1fa27e35c4e791702b', paths: ['testdata', 'testsuite'], license: 'ISC' },
];

const CORPORA_ROOT = join(import.meta.dirname, '..', '.corpora');

/** Labels of the BioJulia specimens, read from the index file its maintainers keep next to the data. */
let specimenLabels: Map<string, 'valid' | 'invalid'> | null = null;
function specimenLabel(rel: string): 'valid' | 'invalid' | null {
  if (!specimenLabels) {
    specimenLabels = new Map();
    const file = join(CORPORA_ROOT, 'BioFmtSpecimens', 'GFF3', 'index.yml');
    if (existsSync(file)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/^- filename:\s*(\S+)\s*\n\s+valid:\s*(true|false)/gm)) specimenLabels.set(m[1]!, m[2] === 'true' ? 'valid' : 'invalid');
    }
  }
  return specimenLabels.get(rel) ?? null;
}

/**
 * GenomeTools test files carry no labels of their own. What its maintainers expect of each file is written in the
 * test suite: `run_test "gt <tool> FILE"` must exit 0, `run_test(..., :retval => 1)` must fail.
 * Only calls with a single test file and no option are used, because options change what `gt` accepts
 * (`-tidy` repairs, `-typecheck`, `-strict` and `-checkids` add requirements). A file expected to both pass and
 * fail in such calls gets no label.
 */
export function genomeToolsLabels(script: string, tool: string): Map<string, 'valid' | 'invalid'> {
  const out = new Map<string, 'valid' | 'invalid' | null>();
  const file = join(CORPORA_ROOT, 'genometools', 'testsuite', script);
  if (!existsSync(file)) return new Map();
  const src = readFileSync(file, 'utf8').replace(/"\s*\+\s*\\?\s*\n\s*"/g, '').replace(/,\s*\\?\s*\n\s*/g, ', ');
  const call = new RegExp(`run_test\\(?\\s*"#\\{\\$bin\\}gt ${tool} #\\{\\$testdata\\}([A-Za-z0-9_.#{}-]+)"(.*)$`);
  let loop: [number, number] | null = null;
  for (const line of src.split('\n')) {
    const up = /^(\d+)\.upto\((\d+)\) do \|i\|/.exec(line);
    if (up) { loop = [Number(up[1]), Number(up[2])]; continue; }
    if (/^end\b/.test(line)) { loop = null; continue; }
    const m = call.exec(line);
    if (!m) continue;
    const expect = /:retval\s*=>\s*1\b/.test(m[2]!) ? 'invalid' : /:retval/.test(m[2]!) && !/:retval\s*=>\s*0\b/.test(m[2]!) ? null : 'valid';
    const names: string[] = [];
    if (m[1]!.includes('#{i}')) { if (loop) for (let i = loop[0]; i <= loop[1]; i++) names.push(m[1]!.replace('#{i}', String(i))); }
    else if (!m[1]!.includes('#{')) names.push(m[1]!);
    for (const name of names) out.set(name, out.has(name) && out.get(name) !== expect ? null : expect);
  }
  const labels = new Map<string, 'valid' | 'invalid'>();
  for (const [k, v] of out) if (v) labels.set(k, v);
  return labels;
}

let gtLabels: Map<string, 'valid' | 'invalid'> | null = null;
function gtLabel(rel: string): 'valid' | 'invalid' | null {
  if (!gtLabels) {
    gtLabels = genomeToolsLabels('gt_gff3_include.rb', 'gff3');
    for (const [k, v] of genomeToolsLabels('gt_gff3validator_include.rb', '(?:gff3|gff3validator)')) if (!gtLabels.has(k)) gtLabels.set(k, v);
  }
  return gtLabels.get(rel) ?? null;
}

export const suites: Suite[] = [
  // The one bgzip-compressed specimen (TAIR10.part.gff.bgz) is left out: the scoring script only unpacks `.gz`.
  { name: 'BioFmtSpecimens GFF3', corpus: 'BioFmtSpecimens', dir: 'GFF3', format: 'gff3', include: /\.gff3?$/, label: specimenLabel },
  { name: 'GenomeTools gt gff3', corpus: 'genometools', dir: 'testdata', format: 'gff3', include: /^[^/]+$/, label: gtLabel },
];

export const notes = [
  'GFF3: the BioFmtSpecimens labels are read from its `GFF3/index.yml`. GenomeTools files have no labels of their own: a file counts as valid or invalid when the GenomeTools test suite (`testsuite/gt_gff3_include.rb`, `gt_gff3validator_include.rb`) runs `gt gff3` or `gt gff3validator` on that file alone, without options, and expects exit status 0 or 1. Files that the suite only runs with options, or pipes through other commands, are not scored. Exit status 0 includes files that GenomeTools accepts while printing a warning the suite checks for (a blank after the seqid, a negative `##sequence-region` coordinate).',
  'GFF3: agreement is counted per file, not per reason. Four GenomeTools files (`cds_check_fail_1` to `_4`) are rejected by both, but for different reasons: GenomeTools objects to a CDS phase that does not follow from the preceding segments, which biolint does not check, and biolint objects to an empty source column in the same files.',
];

export const adjudications: Adjudication[] = [
  // ----- corpus says invalid, biolint reports no error
  { label: 'invalid', path: /genometools\/testdata\/gt_gff3_test_27\.gff3/, verdict: 'beyond-spec',
    why: 'A `##sequence-region` line comes after a feature on that sequence. GenomeTools requires the directive first; the specification does not say where it must be.' },
  { label: 'invalid', path: /genometools\/testdata\/md5_seqid_/, verdict: 'beyond-spec',
    why: 'The seqid breaks the `md5:<checksum>:<name>` convention, which is a GenomeTools extension and not part of GFF3.' },

  // ----- corpus says valid, biolint reports an error
  { label: 'valid', path: /genometools\/testdata\/cds_check_succ_\d+\.gff3/, verdict: 'corpus-error',
    why: 'Line 7 has an empty source column. The specification requires `.` for an undefined field; GenomeTools happens to accept an empty one.' },
  { label: 'valid', path: /genometools\/testdata\/gt_gff3_whitespace_problem\.gff3/, verdict: 'corpus-error',
    why: 'The seqid ends with a space. GenomeTools removes it with a warning; the specification says a seqid may not contain unescaped whitespace.' },
  { label: 'valid', path: /genometools\/testdata\/sequence_region_negative_(start|end)\.gff3/, verdict: 'corpus-error',
    why: 'The `##sequence-region` has a negative coordinate. GenomeTools only warns unless run with -strict (the same test suite expects -strict to fail); GFF3 coordinates are positive integers.' },
  { label: 'valid', path: /genometools\/testdata\/uppercase_attributes\.gff3/, verdict: 'corpus-error',
    why: 'The file tests that all reserved tag names are accepted and fills them with the placeholder `xxx`; `Gap=xxx` is not a Gap string as the specification defines it.' },
  { label: 'valid', path: /BioFmtSpecimens\/GFF3\/ERCC92\.gff3/, verdict: 'corpus-error',
    why: '`##gff-version 3` is on line 3, after two comment lines written by gffread; the specification requires it to be the topmost line. (The default profile accepts the file.)' },
  { label: 'valid', path: /BioFmtSpecimens\/GFF3\/only_fasta\.gff3/, verdict: 'corpus-error',
    why: 'The file holds only FASTA records and has no `##gff-version` line, which the specification says must be present. (The default profile accepts the file with a warning.)' },
  { label: 'valid', path: /BioFmtSpecimens\/GFF3\/mm9_sample_ensembl\.gff3/, verdict: 'corpus-error',
    why: 'Each gene and its transcript share one ID (the transcript line reads `ID=X;Parent=X`), so the IDs are not unique, which the specification requires.' },
  { label: 'valid', path: /BioFmtSpecimens\/GFF3\/knownGene2?\.gff3/, verdict: 'deliberate',
    why: 'One line carries `Ontology_term` twice. The specification writes several values as one comma-separated list and does not say what a repeated tag means; GenomeTools rejects it and biolint follows in strict mode (a warning by default).' },
  { label: 'valid', path: /BioFmtSpecimens\/GFF3\/knownGene_out_of_order\.gff3/, verdict: 'deliberate',
    why: 'A parser stress test: one ID is used on chr9 and chr30, and features on chr17 name a chr9 feature as Parent. The specification does not forbid either in so many words; biolint follows GenomeTools, which rejects both.' },
];
