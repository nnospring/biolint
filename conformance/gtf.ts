// GTF conformance: the corpora it is scored against, and an explanation for every disagreement.
import type { Adjudication, Corpus, Suite } from './types.ts';
import { genomeToolsLabels } from './gff3.ts';

export const corpora: Corpus[] = [
  // Same pin as conformance/gff3.ts.
  { name: 'genometools', repo: 'https://github.com/genometools/genometools.git', commit: '5cd9b0fe1e78449011b15a1fa27e35c4e791702b', paths: ['testdata', 'testsuite'], license: 'ISC' },
];

let labels: Map<string, 'valid' | 'invalid'> | null = null;

export const suites: Suite[] = [
  { name: 'GenomeTools gt gtf_to_gff3', corpus: 'genometools', dir: 'testdata', format: 'gtf', include: /\.gtf$/,
    label: (rel) => (labels ??= genomeToolsLabels('gt_gtf_to_gff3_include.rb', 'gtf_to_gff3')).get(rel) ?? null },
];

export const notes = [
  'GTF: no third-party collection of GTF files labelled valid/invalid was found. The only labelled material is six files in the GenomeTools test data, and their labels are the exit status its test suite (`testsuite/gt_gtf_to_gff3_include.rb`) expects from the converter `gt gtf_to_gff3` run without options. A converter fails for reasons of its own as well as for format errors, so this suite is weak evidence.',
  'GTF: one of the five agreements on invalid files is a coincidence. `gt_gtf_to_gff3_test_inconsistent_strand2.gtf` is rejected by GenomeTools because a transcript is on the other strand than its gene; biolint compares strands within a transcript only, and rejects the file in strict mode because `transcript_id` is not the second attribute and a start codon has no frame.',
];

export const adjudications: Adjudication[] = [
  { label: 'invalid', path: /gt_gtf_to_gff3_test_fail_no_flank\.gtf/, verdict: 'beyond-spec',
    why: 'A stop_codon line lies five kilobases beyond the last exon of its transcript. The converter needs a CDS next to the stop codon to merge the two; GTF 2.2 has no such rule, and biolint does not check that codons lie inside exons.' },
];
