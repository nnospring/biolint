// FASTQ conformance: the corpora it is scored against, and an explanation for every disagreement.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adjudication, Corpus, Suite } from './types.ts';

export const corpora: Corpus[] = [
  // Biopython's Tests/Quality holds the test cases published with Cock et al. 2010 (the paper that defines FASTQ):
  // invalid files "which any parser should reject" and valid but challenging files with their conversions.
  { name: 'biopython', repo: 'https://github.com/biopython/biopython.git', commit: '86e9ea56dbd67f51565fc9566e4f87a888f94454', paths: ['Tests/Quality'],
    license: 'Biopython License Agreement or BSD-3-Clause (LICENSE.rst)' },
  // The BioJulia specimen collection. Its FASTQ files are byte-for-byte copies of the Biopython ones, with labels in FASTQ/index.yml.
  { name: 'BioFmtSpecimens', repo: 'https://github.com/BioJulia/BioFmtSpecimens.git', commit: 'a88ddc9ceca014f47716406f0ede706a70bbbe49', paths: ['FASTQ'],
    license: 'mixed: each specimen keeps the licence of its origin (LICENSE.md; the FASTQ specimens are from Biopython)' },
];

const CORPORA_ROOT = join(import.meta.dirname, '..', '.corpora');

/** Labels of the BioJulia specimens, read from the index file its maintainers keep next to the data. */
let specimenLabels: Map<string, 'valid' | 'invalid'> | null = null;
function specimenLabel(rel: string): 'valid' | 'invalid' | null {
  if (!specimenLabels) {
    specimenLabels = new Map();
    const file = join(CORPORA_ROOT, 'BioFmtSpecimens', 'FASTQ', 'index.yml');
    if (existsSync(file)) {
      // Entries list their fields in no fixed order, and a few have no `valid:` field: those stay unlabelled.
      let name = '';
      for (const l of readFileSync(file, 'utf8').split('\n')) {
        const f = /^\s*-\s*filename:\s*(\S+)/.exec(l);
        if (f) { name = f[1]!; continue; }
        const v = /^\s+valid:\s*(true|false)\s*$/.exec(l);
        if (v && name) specimenLabels.set(name, v[1] === 'true' ? 'valid' : 'invalid');
      }
    }
  }
  return specimenLabels.get(rel) ?? null;
}

/**
 * Biopython labels by file name. `error_*.fastq` are the invalid files of the paper. The valid files of the paper are
 * the `<set>_original_<variant>` files and their conversions `<set>_as_<variant>`. Other files in the directory
 * (examples for other tests) carry no label of their own and are not scored in this suite.
 */
const biopythonLabel = (rel: string): 'valid' | 'invalid' | null =>
  /^error_[a-z_]+\.fastq$/.test(rel) ? 'invalid' : /_(original|as)_(sanger|solexa|illumina)\.fastq$/.test(rel) ? 'valid' : null;

export const suites: Suite[] = [
  { name: 'Biopython FASTQ (Cock et al. test cases)', corpus: 'biopython', dir: 'Tests/Quality', format: 'fastq', include: /^[^/]+\.fastq$/, label: biopythonLabel },
  { name: 'BioFmtSpecimens FASTQ', corpus: 'BioFmtSpecimens', dir: 'FASTQ', format: 'fastq', include: /\.fastq$/, label: specimenLabel },
];

export const notes: string[] = [
  'The two FASTQ suites are not independent: the BioFmtSpecimens FASTQ files are copies of the Biopython test files. They differ only in where the labels come from (file names in Biopython, an index file in BioFmtSpecimens).',
];

export const adjudications: Adjudication[] = [];
