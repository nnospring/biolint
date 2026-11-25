// FASTA conformance: the corpora it is scored against, and an explanation for every disagreement.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adjudication, Corpus, Suite } from './types.ts';

export const corpora: Corpus[] = [
  // Specimens collected by the BioJulia project from the test data of Biopython, BioPerl, BioRuby and UniProt.
  // FASTA/index.yml marks each file `valid: true|false`; at this commit every FASTA specimen is marked valid.
  { name: 'BioFmtSpecimens', repo: 'https://github.com/BioJulia/BioFmtSpecimens.git', commit: 'a88ddc9ceca014f47716406f0ede706a70bbbe49', paths: ['FASTA'],
    license: 'mixed: each specimen keeps the licence of its origin (index.yml names it: BioPerl 29, Biopython 15, BioRuby 3, UniProt 1; LICENSE.md reproduces the Biopython License Agreement and the BioPerl Artistic License, and has no text for the BioRuby and UniProt specimens)' },
  // The test files of Rob Edwards' fasta_validate, the only FASTA corpus found that contains files meant to be rejected.
  { name: 'fasta_validator', repo: 'https://github.com/linsalrob/fasta_validator.git', commit: 'a7cbc40f4264b20222f0736e58cc6b700f099eb1', paths: ['test'], license: 'MIT' },
];

const CORPORA_ROOT = join(import.meta.dirname, '..', '.corpora');

/** Labels of the BioJulia specimens, read from the index file its maintainers keep next to the data. */
let specimenLabels: Map<string, 'valid' | 'invalid'> | null = null;
function specimenLabel(rel: string): 'valid' | 'invalid' | null {
  if (!specimenLabels) {
    specimenLabels = new Map();
    const file = join(CORPORA_ROOT, 'BioFmtSpecimens', 'FASTA', 'index.yml');
    if (existsSync(file)) {
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
 * fasta_validator has no index; what its author expects of each file is written in `test.sh` at the pinned commit:
 * the three `good*` files "should return 0", the others are run as files that "should give error messages"
 * (the `blank_sequence*` files exercise exit code 8, "a sequence with zero length"). Files that `test.sh` does not
 * mention (`code.fasta.old`) are not labelled.
 */
const FASTA_VALIDATOR: Record<string, 'valid' | 'invalid'> = {
  'good.fasta': 'valid', 'good_mixed.fasta': 'valid', 'good_multiline.fasta': 'valid',
  'no_first_line.fasta': 'invalid', 'space.fasta': 'invalid', 'duplicates_no_spaces.fasta': 'invalid', 'duplicates_with_spaces.fasta': 'invalid',
  'code.fasta': 'invalid', 'blank_sequence1.fasta': 'invalid', 'blank_sequence2.fasta': 'invalid', 'blank_sequence3.fasta': 'invalid',
};

export const suites: Suite[] = [
  { name: 'BioFmtSpecimens FASTA', corpus: 'BioFmtSpecimens', dir: 'FASTA', format: 'fasta', include: /\.(fasta|txt)$/, label: specimenLabel },
  { name: 'fasta_validator FASTA', corpus: 'fasta_validator', dir: 'test', format: 'fasta', include: /\.fasta$/, label: (rel) => FASTA_VALIDATOR[rel] ?? null },
];

export const notes: string[] = [
  'FASTA has no formal specification, and every BioFmtSpecimens FASTA file is labelled valid, so that suite can only show false rejections; the files meant to be rejected come from the small fasta_validator suite.',
];

export const adjudications: Adjudication[] = [
  // ----- corpus says valid, biolint (strict) reports an error
  { label: 'valid', path: /FASTA\/(aster|bug2901|dna2|f002|lavender|phlox|rosemary)\.fasta$/, verdict: 'deliberate',
    why: 'The last line has no terminating newline. Nothing written about FASTA requires one; the generic text rule TXT009 is an error in the strict profile because concatenating such a file glues its last sequence line to the next header. No FASTA rule fires on these files.' },
  { label: 'valid', path: /FASTA\/badfasta\.fasta$/, verdict: 'corpus-error',
    why: 'A blank line splits the sequence of the second record. NCBI states that blank lines are not allowed in the middle of FASTA input and samtools faidx cannot index the file; the index entry itself notes that BioPerl, where the file comes from, considers it invalid.' },
  { label: 'valid', path: /FASTA\/example1\.txt$/, verdict: 'deliberate',
    why: 'Sequence lines contain pairs of spaces (the "cutpoints" of a BioRuby test) and three records reuse an earlier identifier. Spaces are not residue codes in the NCBI description and shift the coordinates of a faidx index, so biolint reports them as errors; some parsers strip them.' },
  { label: 'valid', path: /FASTA\/f003\.fasta$/, verdict: 'deliberate',
    why: 'The file has `#` comment lines before, between and after the records, a Biopython test of its own leniency (the file says "I don\'t really know if FASTA format is supposed to support this"). No description of FASTA has `#` comments, and samtools faidx stops at the first one.' },
  { label: 'valid', path: /FASTA\/pictogram\.fasta$/, verdict: 'deliberate',
    why: 'Ten of the fourteen records reuse an earlier identifier (`seq3`, `seq4`, ...). Parsers read the file, but an index keeps only the first record of that name (samtools faidx: "Ignoring duplicate sequence"), so biolint makes duplicate identifiers a warning by default and an error in the strict profile.' },
];
