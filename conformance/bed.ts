// BED conformance: the corpora it is scored against, and an explanation for every disagreement.
import type { Adjudication, Corpus, Suite } from './types.ts';

const BED_TYPES = ['03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

export const corpora: Corpus[] = [
  // The BED test suite of Niu, Roberts, Denisko and Hoffman (Bioinformatics 2022), written alongside the GA4GH specification.
  { name: 'acidbio', repo: 'https://github.com/hoffmangroup/acidbio.git', commit: 'f3a01593060a66895b4bd33c0ed661e6123be73e', paths: BED_TYPES.map((t) => `bed/BED${t}`), license: 'GPL-2.0 (stated in the repository README)' },
  // Specimens collected by BioJulia from the test data of other projects; the BED ones come from the UCSC "kent" source tree.
  { name: 'BioFmtSpecimens', repo: 'https://github.com/BioJulia/BioFmtSpecimens.git', commit: 'a88ddc9ceca014f47716406f0ede706a70bbbe49', paths: ['BED'], license: 'per specimen, see LICENSE.md of the repository: the BED files are from the UCSC kent tree (free for personal, academic and non-profit use)' },
];

/**
 * BioFmtSpecimens labels its files in `BED/index.yml` (`valid: true|false`). The labels at the pinned commit are
 * transcribed here rather than read at run time, so that this module can be imported before the corpus is fetched.
 * `ws245Genes.WBGene.bed.bgz` (valid) is left out: the conformance script only decompresses `.gz` names.
 */
const SPECIMENS: Record<string, 'valid' | 'invalid'> = {
  'itemRgb.bed': 'valid',
  'bedPileUps-foo.bed': 'valid',
  'vgLoadMahoney-clonePcr.bed': 'valid',
  'overlapSelect-NM_001206.bed': 'valid',
  'overlapSelect-NM_015110.bed': 'valid',
  'overlapSelect-NM_015110.split.bed': 'valid',
  'overlapSelect-ceil1.in.bed': 'valid',
  'overlapSelect-ceil1.sel.bed': 'valid',
  'overlapSelect-mrna.bed': 'valid',
  'overlapSelect-refgene.bed': 'valid',
  'overlapSelect-statsSelect.bed': 'valid',
  'overlapSelect-wideIn.bed': 'invalid',
  'overlapSelect-wideSelect.bed': 'valid',
};

export const suites: Suite[] = [
  // acidbio sorts its files into `good/` and `bad/` under one directory per BED type; the directory is the label.
  ...BED_TYPES.map((t): Suite => ({
    name: `acidbio BED${t}`, corpus: 'acidbio', dir: `bed/BED${t}`, format: 'bed', include: /^(good|bad)\/[^/]+\.bed$/,
    label: (rel) => (rel.startsWith('good/') ? 'valid' : rel.startsWith('bad/') ? 'invalid' : null),
  })),
  { name: 'BioFmtSpecimens BED', corpus: 'BioFmtSpecimens', dir: 'BED', format: 'bed', include: /\.bed$/, label: (rel) => SPECIMENS[rel] ?? null },
];

export const notes = [
  'The acidbio files are labelled for one BED type each (the directory name), which is information the files themselves do not carry. biolint infers the layout from the first data line, so a file whose only defect is on that line in its last standard column is read as having a custom column there; those cases are listed as deliberate disagreements.',
];

export const adjudications: Adjudication[] = [
  // ----- corpus says invalid, biolint reports no error
  { label: 'invalid', path: /acidbio\/.*\/03-chromEnd_too_large\.bed$/, verdict: 'not-implemented',
    why: 'chromEnd is 4294967296 on chr20, beyond the end of that chromosome (§1.6). Checking it needs chromosome sizes, which biolint does not take; without them the specification allows values up to 2^64−1, so biolint only warns (BED024).' },
  { label: 'invalid', path: /acidbio\/.*\/04-name_with_spaces\.bed$/, verdict: 'corpus-error',
    why: 'The file is separated by single tabs throughout, and §1.7 allows whitespace in the name in exactly that case; §3.2 only recommends against it. biolint warns (BED030).' },
  { label: 'invalid', path: /acidbio\/bed\/BED12\/bad\/12-bed13\.bed$/, verdict: 'beyond-spec',
    why: 'A thirteenth column after twelve valid BED fields is a custom field (BED12+1, §1.3 and §1.10). The corpus rejects it only because the directory expects exactly BED12, which the file itself cannot declare.' },
  { label: 'invalid', path: /acidbio\/.*\/(07-string_thickStart|08-float_thickEnd|08-string_thickEnd|09-incomplete_rgb|09-invalid_rgb|09-string_rgb|10-blockcount_negative|11-mismatch_count_short)\.bed$/, verdict: 'deliberate',
    why: 'The only defect is on the first data line, the line biolint infers the layout from. Nothing in a BED file says which columns are standard (§4), so the column with the bad value and those after it are read as custom fields, with a note (BED013) quoting the value; the same value on any later line is an error.' },
  { label: 'invalid', path: /BioFmtSpecimens\/BED\/overlapSelect-wideIn\.bed$/, verdict: 'beyond-spec',
    why: 'The line is a consistent BED12 feature followed by 22 further columns, which the specification allows as custom fields (BED12+22). The index gives no reason for the label, and the twelve standard fields break no rule.' },

  // ----- corpus says valid, biolint reports an error
  { label: 'valid', path: /BioFmtSpecimens\/BED\/vgLoadMahoney-clonePcr\.bed$/, verdict: 'corpus-outdated',
    why: 'Chromosome names such as `NM_007524.1` contain a dot. The specimen was labelled against the UCSC description, which has no naming rule; BED v1.0 §1.5 restricts chrom to letters, digits and underscore. biolint accepts the file in its default profile.' },
];
