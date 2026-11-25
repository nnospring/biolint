// SAM conformance: the corpora it is scored against, and an explanation for every disagreement.
import type { Adjudication, Corpus, Suite } from './types.ts';

export const corpora: Corpus[] = [
  { name: 'hts-specs', repo: 'https://github.com/samtools/hts-specs.git', commit: '510c107ba89aa13113818c9e4fa3071283cb7f7b', paths: ['test/sam'], license: 'MIT' },
  // Specimens collected from htslib, Biopython and others; each origin's licence is reproduced in the repository's LICENSE.md.
  { name: 'BioFmtSpecimens', repo: 'https://github.com/BioJulia/BioFmtSpecimens.git', commit: 'a88ddc9ceca014f47716406f0ede706a70bbbe49', paths: ['SAM'], license: 'various (MIT, Biopython License; see LICENSE.md)' },
];

export const suites: Suite[] = [
  { name: 'hts-specs SAM', corpus: 'hts-specs', dir: 'test/sam', format: 'sam', include: /\.sam$/,
    label: (rel) => (rel.startsWith('passed/') ? 'valid' : rel.startsWith('failed/') ? 'invalid' : null) },
  // SAM/index.yml marks every one of its entries `valid: true` at the pinned commit, so the label is constant.
  { name: 'BioFmtSpecimens SAM', corpus: 'BioFmtSpecimens', dir: 'SAM', format: 'sam', include: /\.sam$/, label: () => 'valid' },
];

export const notes: string[] = [];

export const adjudications: Adjudication[] = [
  // ----- corpus says invalid, biolint reports no error
  { label: 'invalid', path: /hts-specs\/test\/sam\/failed\/hdr\.HD3\.sam$/, verdict: 'corpus-error',
    why: 'The file (`@HD VN:1.6 GO:none`) is byte-for-byte identical to passed/hdr.HD6.sam in the same corpus, and `none` is a valid GO value.' },

  // ----- corpus says valid, biolint reports an error
  { label: 'valid', path: /hts-specs\/test\/sam\/passed\/aux\.pass-(B|H)\.sam$/, verdict: 'deliberate',
    why: 'The corpus tests the syntax of optional fields only (its README defers SAMtags semantics) and names tags after their type (`BC:B:`, `H1:H:`, `H2:H:`); biolint also holds BC, H1 and H2 to the types SAMtags predefines for them (Z, i, i).' },
  { label: 'valid', path: /hts-specs\/test\/sam\/passed\/hdr\.PG4\.sam$/, verdict: 'corpus-error',
    why: 'The line `@PG ID:fork-1b PP:fork-1b` names itself as its previous program; the specification says PP must match another @PG line (samtools warns about it too).' },
  { label: 'valid', path: /BioFmtSpecimens\/SAM\/xx#blank\.sam$/, verdict: 'deliberate',
    why: 'The file is empty (0 bytes). biolint reports an empty file as an error for every format (TXT010) because it nearly always means a failed step, and `samtools view` refuses it as well.' },
];
