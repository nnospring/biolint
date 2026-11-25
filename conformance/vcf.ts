// VCF conformance: the corpora it is scored against, and an explanation for every disagreement.
import type { Adjudication, Corpus, Suite } from './types.ts';

export const corpora: Corpus[] = [
  { name: 'hts-specs', repo: 'https://github.com/samtools/hts-specs.git', commit: '510c107ba89aa13113818c9e4fa3071283cb7f7b', paths: ['test/vcf', 'test/sam'], license: 'MIT' },
  { name: 'vcf-validator', repo: 'https://github.com/EBIvariation/vcf-validator.git', commit: '19125af2b1208065c819cd7378fec1784e28a9d7', paths: ['test/input_files'], license: 'Apache-2.0' },
];

const label = (rel: string) => (/(^|\/)passed(\/|_)|(^|\/)[^/]*passed[^/]*\.vcf/.test(rel) ? 'valid' : /failed/.test(rel) ? 'invalid' : null);

export const suites: Suite[] = [
  ...['4.1', '4.2', '4.3'].map((v): Suite => ({ name: `hts-specs VCF ${v}`, corpus: 'hts-specs', dir: `test/vcf/${v}`, format: 'vcf', include: /\.vcf(\.gz)?$/, label })),
  // `assembly_checker` and `evidence` test other programs (reference and evidence checkers), not VCF validity.
  ...['4.1', '4.2', '4.3', '4.4', '4.5'].map((v): Suite => ({ name: `vcf-validator VCF ${v}`, corpus: 'vcf-validator', dir: `test/input_files/v${v}`, format: 'vcf', include: /\.vcf(\.gz)?$/, exclude: /^(assembly_checker|evidence)\//, label })),
];

export const notes = [
  'The two VCF corpora overlap heavily (the hts-specs files were derived from vcf-validator), so they are not independent evidence.',
];

export const adjudications: Adjudication[] = [
  // ----- corpus says invalid, biolint reports no error
  { label: 'invalid', cause: /duplicated variant|triplicated variant/, verdict: 'beyond-spec',
    why: 'The specification permits several records at one position. biolint reports exact duplicates as a warning (VCF501) and does not normalise alleles to find equivalent representations.' },
  { label: 'invalid', cause: /Incorrect order of \w+ fields/, verdict: 'beyond-spec',
    why: 'No version requires a field order inside structured meta lines; VCF 4.4 states that implementations must not rely on it.' },
  { label: 'invalid', cause: /Incorrect ALT (Number|Type) value/, verdict: 'beyond-spec',
    why: '##ALT lines have no Number or Type field in any version; extra fields are free-form.' },
  { label: 'invalid', cause: /Non-valid URL|Meta-data entry is not a key-value pair/, verdict: 'beyond-spec',
    why: 'The specification does not define what makes a ##assembly or ##pedigreeDB URL valid. biolint only requires that it is not empty.' },
  { label: 'invalid', cause: /Genomes field missing|Non-description field containing quotes|SAMPLE ID contains|Value with (whitespace|non-accepted)|Genome ID with|Incorrect META|META Values must/, verdict: 'beyond-spec',
    why: '##SAMPLE, ##PEDIGREE and ##META are described only by example. biolint checks their syntax and that IDs are unique, not their vocabulary.' },
  { label: 'invalid', cause: /contig ID contains illegal character/, verdict: 'corpus-outdated',
    why: 'The contig name uses `*` away from the first position, which the 2019 revision of the VCF 4.3 naming rules made legal.' },
  { label: 'invalid', path: /\/4\.3\//, cause: /contig ID contains a colon/, verdict: 'corpus-outdated',
    why: 'Colons in contig names were made legal by the 2019 revision of VCF 4.3; the sibling corpus has a passing file with one.' },
  { label: 'invalid', cause: /contig ID contains a colon/, verdict: 'beyond-spec',
    why: 'VCF 4.1 and 4.2 place no restriction on colons in contig names.' },
  { label: 'invalid', cause: /SVCLAIM|cardinality is inconsistent|CNV:TR|invalid SV|invalid format fields|invalid info CICN|invalid info field count|invalid sample value/, verdict: 'not-implemented',
    why: 'Semantic rules for structural variants introduced in VCF 4.4 (SVCLAIM, tandem-repeat keys, CN/CICN, phase-set lists) are not checked yet.' },
  { label: 'invalid', path: /v4\.5\/failed\/failed_(body_invalid|meta_format_number_M)/, verdict: 'not-implemented',
    why: 'Semantic rules introduced in VCF 4.5 (local alleles, base modifications, computed END, FORMAT LEN) are not checked yet.' },
  { label: 'invalid', path: /compressed_files\/.*failed_compressed/, verdict: 'beyond-spec',
    why: 'The file is a valid VCF inside the archive; the corpus uses it to test that validation errors are found in compressed input, with a defect biolint classifies as beyond the specification.' },

  // ----- corpus says valid, biolint reports an error
  { label: 'valid', path: /passed_(body_alt|compressed)\.vcf/, verdict: 'corpus-error',
    why: 'A record with no ALT allele carries three GL values. Number=G is one value per genotype, and one allele has one diploid genotype. (In 4.4/4.5 the same file also has the malformed float `-0r.58`.)' },
  { label: 'valid', path: /passed_meta_info\.vcf/, verdict: 'corpus-error',
    why: 'An INFO line is declared `Number=A,Type=Flag`. Every version requires Number=0 for a Flag.' },
  { label: 'valid', path: /\/(v?4\.[12])\/passed\/passed_meta_contig\.vcf/, verdict: 'deliberate',
    why: 'Two ##contig lines share an ID. Uniqueness is stated only from 4.3, but parsers of every version keep a single definition, so biolint reports it throughout.' },
  { label: 'valid', path: /passed_meta_contig\.vcf/, verdict: 'corpus-error',
    why: 'Two ##contig lines share an ID, which VCF 4.3 and later forbid explicitly.' },
  { label: 'valid', path: /\/(v?4\.[12])\/passed\/complexfile_passed/, verdict: 'deliberate',
    why: 'Records of one contig are split by another contig. 4.1/4.2 say such blocks "should" be contiguous; biolint treats it as an error in strict mode because indexing fails either way.' },
  { label: 'valid', path: /hts-specs\/test\/vcf\/4\.3\/passed\/complexfile_passed/, verdict: 'corpus-error',
    why: 'Records of one contig are split by another contig, which VCF 4.3 forbids ("must form a contiguous block").' },
  { label: 'valid', path: /vcf-validator\/.*complexfile_passed/, verdict: 'corpus-error',
    why: 'A meta line has a value starting with `<` that is not a list of key=value entries; from 4.3 such a line is structured and needs an ID.' },
  { label: 'valid', path: /passed_body_info\.vcf/, verdict: 'corpus-error',
    why: 'The file contains END=0 on a record at POS 100 (END cannot precede POS) and, from 4.3, an SB value with one number where the reserved definition is Number=4.' },
  { label: 'valid', path: /passed_body_format\.vcf/, verdict: 'corpus-error',
    why: 'The FORMAT key `G%3AS` does not match the key syntax `[A-Za-z_][0-9A-Za-z_.]*` required from 4.3.' },
  { label: 'valid', path: /passed_body_sample_format_CICN\.vcf/, verdict: 'corpus-error',
    why: 'A genotype is written `0/0|`, with a trailing phasing separator, which the GT grammar does not allow.' },
];
