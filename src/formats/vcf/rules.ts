import { defineRules, ex } from '../../core/rules.ts';

const GOOD_MINIMAL = ex`
  ##fileformat=VCFv4.3
  ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">
  #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
  1→100→.→A→T→.→.→DP=3
`;

export const V = defineRules('vcf', {
  // ---------------------------------------------------------------- meta-information lines
  fileformatMissing: {
    code: 'VCF001',
    title: 'First line is not ##fileformat',
    level: 'error',
    spec: 'VCF 4.3 §1.4.1',
    explanation:
      'Every VCF must begin with a `##fileformat=VCFv4.x` line. Parsers use it to pick the rules for everything that follows; htslib refuses or guesses when it is absent. ' +
      'It goes missing when headers are assembled by hand, when `grep -v "^#"` output is re-headered incompletely, or when a byte-order mark precedes it.',
    bad: [ex`
      ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3
    `],
    good: [GOOD_MINIMAL],
  },
  fileformatInvalid: {
    code: 'VCF002',
    title: 'Unrecognised ##fileformat value',
    level: 'error',
    spec: 'VCF 4.3 §1.4.1',
    explanation: 'The value must be `VCFv` followed by the version, exactly: `VCFv4.1`, `VCFv4.2`, `VCFv4.3`, `VCFv4.4` or `VCFv4.5`. Variants such as `VCF4.2`, `vcfv4.2` or `VCFv4.2 ` (trailing space) are not recognised by parsers.',
    bad: [ex`
      ##fileformat=VCF4.2
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
    `],
  },
  fileformatRepeated: {
    code: 'VCF003',
    title: '##fileformat appears more than once',
    level: 'error',
    spec: 'VCF 4.3 §1.4.1',
    explanation: 'A file has exactly one `##fileformat` line, and it is the first line. A second one almost always means two VCF files were concatenated with `cat`; use `bcftools concat` instead.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
    `],
  },
  metaMalformed: {
    code: 'VCF004',
    title: 'Meta-information line is not ##key=value',
    level: 'error',
    spec: 'VCF 4.3 §1.4',
    explanation: 'Lines before the column header must start with `##` and have the form `##key=value` with a non-empty key and value. A line that lost its `##` (or gained a stray space) is read as a data line and derails parsing.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##source
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
    `],
  },
  metaStructure: {
    code: 'VCF005',
    title: 'Structured meta line is not well-formed',
    level: 'error',
    spec: 'VCF 4.3 §1.4',
    explanation:
      'A structured line is `##key=<k=v,k=v,...>`: it must close with `>`, every entry needs a key and `=`, and a quoted value must end with an unescaped `"`. ' +
      'The usual culprit is a Description containing a `"` that was not escaped as `\\"`, or a missing closing quote.',
    bad: [
      { text: ex`
        ##fileformat=VCFv4.3
        ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth>
        #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
        1→100→.→A→T→.→.→DP=3
      `, note: 'the Description never closes its quote' },
    ],
  },
  metaIdMissing: {
    code: 'VCF006',
    title: 'Structured meta line has no ID',
    level: 'error',
    spec: 'VCF 4.3 §1.4',
    explanation: 'Every structured line (`##INFO`, `##FORMAT`, `##FILTER`, `##ALT`, `##contig`, `##SAMPLE`, ...) is identified by its `ID`. Without one it cannot be referred to from records.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##FILTER=<Description="Low quality">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
    `],
  },
  metaIdDuplicate: {
    code: 'VCF007',
    title: 'Two meta lines of the same kind share an ID',
    level: 'error',
    spec: 'VCF 4.3 §1.4',
    explanation: 'IDs must be unique among lines with the same `##key=` prefix. With duplicates, which definition a parser keeps is implementation-defined: htslib keeps the first and warns. Duplicates usually come from merging headers by hand.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">
      ##INFO=<ID=DP,Number=1,Type=Float,Description="Depth again">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3
    `],
  },
  metaFieldMissing: {
    code: 'VCF008',
    title: 'Meta line lacks a required field',
    level: 'error',
    spec: 'VCF 4.3 §1.4.2',
    explanation: '`##INFO` and `##FORMAT` need `ID`, `Number`, `Type` and `Description`; `##FILTER` and `##ALT` need `ID` and `Description`. htslib rejects INFO/FORMAT definitions without Number or Type.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Type=Integer,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3
    `],
  },
  metaNumberInvalid: {
    code: 'VCF009',
    title: 'Invalid Number in INFO/FORMAT definition',
    level: 'error',
    spec: 'VCF 4.3 §1.4.2',
    explanation: '`Number` is a non-negative integer, or `A` (one per ALT allele), `R` (one per allele including REF, from 4.2), `G` (one per genotype) or `.` (varies). VCF 4.4 adds `P`, and 4.5 adds `LA`, `LR`, `LG` and `M`, for FORMAT only.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=AF,Number=alt,Type=Float,Description="Allele frequency">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→AF=0.5
    `],
  },
  metaTypeInvalid: {
    code: 'VCF010',
    title: 'Invalid Type in INFO/FORMAT definition',
    level: 'error',
    spec: 'VCF 4.3 §1.4.2',
    explanation: '`Type` is one of `Integer`, `Float`, `Flag`, `Character`, `String` for INFO, and the same without `Flag` for FORMAT. The names are case-sensitive and not abbreviated.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Number=1,Type=Int,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3
    `],
  },
  metaFlagNumber: {
    code: 'VCF011',
    title: 'Flag must have Number=0 (and only Flag may)',
    level: 'error',
    spec: 'VCF 4.3 §1.4.2',
    explanation: 'A `Flag` carries no value, so its `Number` must be `0`. Conversely `Number=0` only makes sense for a Flag.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DB,Number=1,Type=Flag,Description="dbSNP membership">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DB
    `],
  },
  metaDescriptionUnquoted: {
    code: 'VCF012',
    title: 'Description is not a quoted string',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.4.2',
    explanation: 'The Description must be surrounded by double quotes. Unquoted text is cut at the first comma by most parsers, and bcftools rewrites such headers with a warning.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Number=1,Type=Integer,Description=Total depth>
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3
    `],
  },
  metaReservedMismatch: {
    code: 'VCF013',
    title: 'Reserved key declared with a different Number or Type',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.6.1, §1.6.2',
    explanation:
      'The specification fixes Number and Type for reserved keys such as `AC` (A, Integer), `AF` (A, Float), `DP` (1, Integer), `GT` (1, String), `AD` (R, Integer), `PL` (G, Integer). ' +
      'Tools rely on those definitions: `bcftools norm` splits multiallelic `AC`/`AF` per allele only when they are declared `Number=A`.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=AF,Number=1,Type=Float,Description="Allele frequency">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→AF=0.5
    `],
  },
  metaIdInvalid: {
    code: 'VCF014',
    title: 'ID contains characters that are not allowed',
    level: 'error',
    spec: 'VCF 4.3 §1.4, §1.6.1',
    explanation:
      'INFO and FORMAT keys must match `[A-Za-z_][0-9A-Za-z_.]*` (4.3 and later). FILTER IDs may not contain whitespace or semicolons and may not be `0`. ' +
      'Contig names may not contain whitespace, commas or angle brackets. IDs with such characters cannot be told apart from the delimiters around them.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=read-depth,Number=1,Type=Integer,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
    `],
  },
  metaAfterHeader: {
    code: 'VCF015',
    title: 'Meta-information line after the column header',
    level: 'error',
    spec: 'VCF 4.3 §1.4',
    explanation: 'All `##` lines must come before the `#CHROM` line. A `##` line further down is what `cat a.vcf b.vcf` produces: use `bcftools concat` or `bcftools merge`, which reconcile the headers.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
      ##source=second_file
      1→200→.→G→C→.→.→.
    `],
  },
  metaOptionalUnquoted: {
    code: 'VCF016',
    title: 'Optional meta field value is not quoted',
    level: 'off',
    strict: 'warning',
    spec: 'VCF 4.3 §1.4',
    explanation: 'From VCF 4.3, values of optional fields in INFO/FORMAT/FILTER/ALT lines (`Source`, `Version`, and any custom ones) must be written as quoted strings, even when numeric. Parsers accept the unquoted form, so this is reported in strict mode only.',
    bad: [{ profile: 'strict', text: ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth",Version=3>
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3
    ` }],
  },
  contigLengthInvalid: {
    code: 'VCF017',
    title: 'Contig length is not a positive integer',
    level: 'error',
    spec: 'VCF 4.3 §1.4.7',
    explanation: 'The `length` of a `##contig` line must be a positive integer. tabix and `bcftools index` use it to size the index; units, decimals and separators break that.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##contig=<ID=1,length=248.9Mb>
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
    `],
  },
  metaKeyCase: {
    code: 'VCF018',
    title: 'Meta key differs from a standard key only by case',
    level: 'warning',
    spec: 'VCF 4.3 §1.4',
    explanation: 'Meta keys are case-sensitive: `##Info=` or `##format=` is an unrelated custom line, so the definitions it was meant to provide are silently missing.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##info=<ID=DP,Number=1,Type=Integer,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
    `],
  },
  metaNumberVersion: {
    code: 'VCF019',
    title: 'Number value is newer than the declared VCF version',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.2 §1.2.2',
    explanation: '`Number=R` exists from VCF 4.2. A 4.1 header using it is accepted by htslib but rejected by parsers that follow the declared version.',
    bad: [ex`
      ##fileformat=VCFv4.1
      ##INFO=<ID=AD,Number=R,Type=Integer,Description="Allelic depths">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→AD=3,4
    `],
  },
  altTypeUnknown: {
    code: 'VCF020',
    title: 'ALT definition does not use a defined structural variant type',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.2 §1.2.5',
    explanation: 'The first colon-separated component of a structural-variant `##ALT` ID must be `DEL`, `INS`, `DUP`, `INV` or `CNV`. VCF 4.1 and 4.2 apply this to every `##ALT` line; from 4.3 other symbolic alleles may use their own names, so only IDs written as `type:subtype` are checked.',
    bad: [ex`
      ##fileformat=VCFv4.2
      ##ALT=<ID=DELETION,Description="A deletion">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→<DELETION>→.→.→.
    `],
  },
  // ---------------------------------------------------------------- header line
  headerMissing: {
    code: 'VCF101',
    title: 'Column header line (#CHROM ...) is missing',
    level: 'error',
    spec: 'VCF 4.3 §1.5',
    explanation: 'The `#CHROM POS ID REF ALT QUAL FILTER INFO` line is mandatory and must come before the first record. Without it the number and names of samples are unknown.',
    bad: [ex`
      ##fileformat=VCFv4.3
      1→100→.→A→T→.→.→.
    `],
  },
  headerColumns: {
    code: 'VCF102',
    title: 'Column header does not name the eight fixed columns',
    level: 'error',
    spec: 'VCF 4.3 §1.5',
    explanation:
      'The header must be exactly `#CHROM`, `POS`, `ID`, `REF`, `ALT`, `QUAL`, `FILTER`, `INFO`, tab-separated, optionally followed by `FORMAT` and sample names. ' +
      'Spaces instead of tabs are the most common cause: they appear when a header is pasted from a terminal, an email or a document.',
    bad: [
      { text: '##fileformat=VCFv4.3\n#CHROM POS ID REF ALT QUAL FILTER INFO\n1\t100\t.\tA\tT\t.\t.\t.\n', note: 'columns separated by spaces instead of tabs' },
    ],
  },
  headerFormatSamples: {
    code: 'VCF103',
    title: 'FORMAT column without samples, or samples without FORMAT',
    level: 'error',
    spec: 'VCF 4.3 §1.5',
    explanation: 'If the file carries genotypes, the ninth column is `FORMAT` and at least one sample name follows it. A lone `FORMAT` column or sample names directly after `INFO` are both invalid.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT
      1→100→.→A→T→.→.→.→GT
    `],
  },
  headerDuplicateSample: {
    code: 'VCF104',
    title: 'Duplicate sample name',
    level: 'error',
    spec: 'VCF 4.3 §1.5',
    explanation: 'Sample names must be unique. htslib refuses to open a VCF with duplicate sample columns ("Duplicated sample name"). Rename with `bcftools reheader -s`.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1→S1
      1→100→.→A→T→.→.→.→GT→0/1→0/0
    `],
  },
  headerRepeated: {
    code: 'VCF105',
    title: 'Column header line appears again',
    level: 'error',
    spec: 'VCF 4.3 §1.5',
    explanation: 'A second `#CHROM` line in the body means files were concatenated with `cat`. The second file\'s samples and definitions may differ; use `bcftools concat` (same samples) or `bcftools merge` (different samples).',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→200→.→G→C→.→.→.
    `],
  },
  commentInBody: {
    code: 'VCF106',
    title: 'Comment line among the records',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.4, §1.6',
    explanation:
      'After the `#CHROM` line every line is a data record: VCF has no comment syntax there. Such lines do occur in the wild (`#FGQB` lines in some gVCF files, for example), ' +
      'and a reader is free to skip them or to fail on them.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
      # checked by hand
      1→200→.→G→C→.→.→.
    `],
  },
  // ---------------------------------------------------------------- record structure and fixed fields
  columnCount: {
    code: 'VCF201',
    title: 'Wrong number of columns in a record',
    level: 'error',
    spec: 'VCF 4.3 §1.6',
    explanation:
      'Every record has the same number of tab-separated columns as the header line. Too few usually means spaces were used instead of tabs or the line was truncated; too many means a tab inside a value or a trailing tab.',
    bad: [
      { text: '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1 100 . A T . . .\n', note: 'the record is separated by spaces' },
      ex`
        ##fileformat=VCFv4.3
        #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
        1→100→.→A→T→.→.
      `,
    ],
  },
  emptyField: {
    code: 'VCF202',
    title: 'Empty field',
    level: 'error',
    spec: 'VCF 4.3 §1.6',
    explanation: 'No field may be empty: a missing value is written as `.`. Empty fields appear when a spreadsheet export drops the dot or when two tabs are adjacent.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→→A→T→.→.→.
    `],
  },
  chromInvalid: {
    code: 'VCF203',
    title: 'Invalid CHROM',
    level: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'CHROM is a contig name without whitespace (and, in strict mode, restricted to the characters SAM allows for reference names), or an angle-bracketed assembly ID.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      chr 1→100→.→A→T→.→.→.
    `],
  },
  chromUndeclared: {
    code: 'VCF204',
    title: 'CHROM is not declared in a ##contig line',
    level: 'warning',
    spec: 'VCF 4.3 §1.4.7',
    explanation:
      'The header declares contigs, but not this one. BCF conversion and indexing need every contig declared, and a mismatch such as `chr1` vs `1` between header and records is a frequent source of "empty" query results. ' +
      'Reported once per contig name.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##contig=<ID=chr1,length=248956422>
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
    `],
  },
  posInvalid: {
    code: 'VCF205',
    title: 'Invalid POS',
    level: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'POS is a non-negative integer (1-based; 0 is reserved for telomeres) that fits in 32 bits. Decimal points, thousands separators and scientific notation (`1e+05`, a spreadsheet artefact) are invalid.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→1e+05→.→A→T→.→.→.
    `],
  },
  unsorted: {
    code: 'VCF206',
    title: 'Records are not sorted by position',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'Within a CHROM, positions must be in increasing order. tabix and `bcftools index` fail on unsorted files ("unsorted positions"). Sort with `bcftools sort`.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→200→.→A→T→.→.→.
      1→100→.→G→C→.→.→.
    `],
  },
  chromNotContiguous: {
    code: 'VCF207',
    title: 'Records of one CHROM are not in a single block',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'All records of a CHROM must be adjacent. A contig that reappears later breaks indexing and usually means the file was concatenated out of order. Sort with `bcftools sort`.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
      2→100→.→A→T→.→.→.
      1→200→.→G→C→.→.→.
    `],
  },
  posBeyondContig: {
    code: 'VCF208',
    title: 'POS is beyond the declared contig length',
    level: 'warning',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'POS exceeds `length + 1` of the contig declared in the header. The header and the records were probably produced against different reference builds.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##contig=<ID=1,length=1000>
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→5000→.→A→T→.→.→.
    `],
  },
  idInvalid: {
    code: 'VCF209',
    title: 'Invalid ID',
    level: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'ID is `.` or a semicolon-separated list of identifiers without whitespace, with no empty or repeated entries.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→rs1;;rs2→A→T→.→.→.
    `],
  },
  refInvalid: {
    code: 'VCF210',
    title: 'Invalid REF allele',
    level: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation:
      'REF is one or more of `A`, `C`, `G`, `T`, `N` (any case). It cannot be `.`, `-` or empty: an insertion or deletion includes the preceding reference base. ' +
      'A `-` allele means the file came from a MAF/annovar-style table and needs left-padding against the reference.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→-→T→.→.→.
    `],
  },
  refAmbiguous: {
    code: 'VCF211',
    title: 'REF contains an IUPAC ambiguity code',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'Only `A`, `C`, `G`, `T`, `N` are allowed in REF. Where the reference has another IUPAC code, it must be reduced to the first base alphabetically (`R` becomes `A`). `bcftools norm --check-ref s` repairs this.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→R→T→.→.→.
    `],
  },
  altInvalid: {
    code: 'VCF212',
    title: 'Invalid ALT allele',
    level: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'Each comma-separated ALT allele is a string of `A`/`C`/`G`/`T`/`N`, `*` (spanning deletion, from 4.2), `.` (no variant, alone), a symbolic allele `<ID>`, or a breakend such as `G]17:198982]`. `-`, empty entries and lower-level notation such as `A>T` are invalid.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T,→.→.→.
    `],
  },
  altUndeclared: {
    code: 'VCF213',
    title: 'Symbolic ALT allele is not declared',
    level: 'warning',
    spec: 'VCF 4.3 §1.4.5',
    explanation: 'A symbolic allele such as `<DEL>` should have a matching `##ALT=<ID=DEL,...>` line. `<*>` and `<NON_REF>` (gVCF) need none. Reported once per allele.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→<DEL>→.→.→.
    `],
  },
  altDuplicate: {
    code: 'VCF214',
    title: 'ALT repeats an allele or equals REF',
    level: 'warning',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'The ALT list holds distinct non-reference alleles. A repeated allele, or one identical to REF, makes allele indices and per-allele annotations (`AC`, `AF`, `AD`) ambiguous.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T,T→.→.→.
    `],
  },
  qualInvalid: {
    code: 'VCF215',
    title: 'Invalid QUAL',
    level: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'QUAL is a number or `.`. Text such as `NA`, `PASS` (a shifted column) or a decimal comma is invalid.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→NA→.→.
    `],
  },
  filterInvalid: {
    code: 'VCF216',
    title: 'Invalid FILTER',
    level: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'FILTER is `PASS`, `.`, or a semicolon-separated list of filter names without whitespace, empty entries or repeats. `0` is reserved, and `PASS` cannot be combined with failed filters.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##FILTER=<ID=q10,Description="Quality below 10">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→PASS;q10→.
    `],
  },
  filterUndeclared: {
    code: 'VCF217',
    title: 'FILTER name is not declared in the header',
    level: 'warning',
    spec: 'VCF 4.3 §1.4.3',
    explanation: 'Each filter used in records should have a `##FILTER=<ID=...>` line. htslib adds a placeholder and warns; BCF cannot store an undeclared filter. Reported once per name.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→LowQual→.
    `],
  },
  qualNegative: {
    code: 'VCF218',
    title: 'QUAL is negative',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'QUAL is −10·log10 of an error probability, so it cannot be negative. A negative value usually means another column slipped into this position, or a caller wrote a log-likelihood.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→-10→.→.
    `],
  },
  chromCharacters: {
    code: 'VCF219',
    title: 'Contig name contains characters that are not allowed',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.4.7',
    explanation: 'Contig names follow the SAM rules (stated explicitly from VCF 4.3): printable ASCII except `\\ , " \` \' ( ) [ ] { } < >`, not starting with `*` or `=`. Names outside this set collide with region syntax (`chr:start-end`), breakend notation or `##contig` parsing. Reported once per name.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      chr1,alt→100→.→A→T→.→.→.
    `],
  },
  // ---------------------------------------------------------------- INFO
  infoMalformed: {
    code: 'VCF301',
    title: 'INFO is not a list of key[=value] entries',
    level: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'INFO is `.` or semicolon-separated `key` / `key=value` entries. An entry without a key (`=5`), or a key with characters outside `[A-Za-z0-9_.]`, cannot be parsed reliably.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→=5
    `],
  },
  infoEmptyEntry: {
    code: 'VCF302',
    title: 'Empty INFO entry (stray semicolon)',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'A leading, trailing or doubled semicolon leaves an empty entry. htslib skips it, but stricter parsers (GATK/htsjdk, vcf-validator) reject the record.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3;
    `],
  },
  infoDuplicateKey: {
    code: 'VCF303',
    title: 'Duplicate INFO key',
    level: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'A key may appear once per record. Which value survives a duplicate differs between tools, so annotations silently disagree. Usually produced by annotating the same file twice.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3;DP=5
    `],
  },
  infoUndeclared: {
    code: 'VCF304',
    title: 'INFO key is not declared in the header',
    level: 'warning',
    spec: 'VCF 4.3 §1.4.2',
    explanation: 'Each INFO key should have a `##INFO=<ID=...>` line. Without it, htslib assumes `Number=1,Type=String` and warns, BCF conversion fails, and type-aware filtering (`INFO/X > 5`) stops working. Reported once per key.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3
    `],
  },
  infoCount: {
    code: 'VCF305',
    title: 'Number of INFO values does not match the declaration',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.4.2',
    explanation:
      'The header fixes how many comma-separated values a key carries: a number, `A` (one per ALT), `R` (one per allele) or `G` (one per genotype). ' +
      'The classic case is a multi-allelic record whose `AC`/`AF` were not split or merged along with the alleles.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=AF,Number=A,Type=Float,Description="Allele frequency">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T,G→.→.→AF=0.5
    `],
  },
  infoType: {
    code: 'VCF306',
    title: 'INFO value does not match the declared Type',
    level: 'error',
    spec: 'VCF 4.3 §1.3',
    explanation: 'An `Integer` must be a whole number, a `Float` a decimal/scientific number (or `inf`/`nan`), a `Character` a single character. Typical offenders: `NA`, `NaN` in an Integer, a decimal in an Integer field, or a decimal comma.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3.5
    `],
  },
  infoFlagValue: {
    code: 'VCF307',
    title: 'Flag has a value, or a non-Flag key has none',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.4.2',
    explanation: 'A `Flag` is present or absent and takes no `=value`. A key of any other type needs a value; a bare key is read as a flag and its declared type is ignored.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP
    `],
  },
  infoWhitespace: {
    code: 'VCF308',
    title: 'Whitespace in INFO',
    level: 'warning',
    spec: 'VCF 4.2 §1.4.1',
    explanation: 'Before VCF 4.3, INFO may not contain whitespace at all; from 4.3 spaces are allowed inside values but not around keys. Older parsers (and anything that splits on whitespace) truncate the record at the space.',
    bad: [ex`
      ##fileformat=VCFv4.2
      ##INFO=<ID=GENE,Number=1,Type=String,Description="Gene name">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→GENE=BRCA 1
    `],
  },
  infoEndBeforePos: {
    code: 'VCF309',
    title: 'INFO END is before POS',
    level: 'error',
    spec: 'VCF 4.3 §3',
    explanation: '`END` is the last reference position covered by the record, so it cannot be smaller than POS. htslib derives the record length from it; a negative length corrupts indexing ("END is smaller than POS").',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=END,Number=1,Type=Integer,Description="End position">
      ##ALT=<ID=DEL,Description="Deletion">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→500→.→A→<DEL>→.→.→END=100
    `],
  },
  integerRange: {
    code: 'VCF310',
    title: 'Integer does not fit in 32 bits',
    level: 'error',
    spec: 'VCF 4.3 §1.3',
    explanation: 'Integers are 32-bit signed, and the eight smallest values (−2³¹ to −2³¹+7) are reserved by BCF for missing/end-of-vector markers. Larger magnitudes overflow when the file is converted to BCF.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→DP=3000000000
    `],
  },
  reservedValue: {
    code: 'VCF311',
    title: 'Reserved INFO key has an impossible value',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'Beyond their type, reserved keys have meanings that bound their values: counts (`AC`, `AN`, `DP`, `NS`, `MQ0`) and `END` cannot be negative, `AF` is a fraction between 0 and 1, `CIGAR` is a CIGAR string.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##INFO=<ID=AF,Number=A,Type=Float,Description="Allele frequency">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→AF=12.5
    `],
  },
  // ---------------------------------------------------------------- FORMAT and samples
  formatMalformed: {
    code: 'VCF401',
    title: 'Invalid FORMAT column',
    level: 'error',
    spec: 'VCF 4.3 §1.6.2',
    explanation: 'FORMAT is a colon-separated list of keys matching `[A-Za-z_][0-9A-Za-z_.]*`, with no empty or repeated key.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
      ##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1
      1→100→.→A→T→.→.→.→GT:DP:DP→0/1:5:5
    `],
  },
  gtNotFirst: {
    code: 'VCF402',
    title: 'GT is not the first FORMAT key',
    level: 'error',
    spec: 'VCF 4.3 §1.6.2',
    explanation: 'When genotypes are present, `GT` must be the first key. htslib and htsjdk both reject records where it is not.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
      ##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1
      1→100→.→A→T→.→.→.→DP:GT→5:0/1
    `],
  },
  formatUndeclared: {
    code: 'VCF403',
    title: 'FORMAT key is not declared in the header',
    level: 'warning',
    spec: 'VCF 4.3 §1.4.4',
    explanation: 'Each FORMAT key should have a `##FORMAT=<ID=...>` line. htslib assumes `Number=1,Type=String` and warns; BCF conversion fails. Reported once per key.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1
      1→100→.→A→T→.→.→.→GT→0/1
    `],
  },
  sampleFieldCount: {
    code: 'VCF404',
    title: 'Sample has more fields than FORMAT has keys',
    level: 'error',
    spec: 'VCF 4.3 §1.6.2',
    explanation: 'A sample column may drop trailing fields but can never have more colon-separated fields than FORMAT lists. Extra fields mean a `:` inside a value or a FORMAT column that lost a key.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1
      1→100→.→A→T→.→.→.→GT→0/1:12
    `],
  },
  gtInvalid: {
    code: 'VCF405',
    title: 'Invalid genotype',
    level: 'error',
    spec: 'VCF 4.3 §1.6.2',
    explanation: 'GT is allele indices separated by `/` (unphased) or `|` (phased), with `.` for a missing allele: `0/1`, `1|0`, `./.`, `1`. Each index must refer to REF (0) or an existing ALT allele.',
    bad: [
      { text: ex`
        ##fileformat=VCFv4.3
        ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
        #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1
        1→100→.→A→T→.→.→.→GT→0/2
      `, note: 'allele 2 does not exist: the record has one ALT allele' },
    ],
  },
  sampleCount: {
    code: 'VCF406',
    title: 'Number of sample values does not match the declaration',
    level: 'warning',
    strict: 'error',
    spec: 'VCF 4.3 §1.4.2',
    explanation: 'As for INFO: `A` is one value per ALT allele, `R` one per allele, `G` one per possible genotype given the sample\'s ploidy. Mismatches arise when alleles were split, merged or trimmed without updating `AD`/`PL`.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
      ##FORMAT=<ID=AD,Number=R,Type=Integer,Description="Allelic depths">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1
      1→100→.→A→T→.→.→.→GT:AD→0/1:10
    `],
  },
  sampleType: {
    code: 'VCF407',
    title: 'Sample value does not match the declared Type',
    level: 'error',
    spec: 'VCF 4.3 §1.3',
    explanation: 'As for INFO: Integer, Float and Character values must parse as such. `NA`, an empty string or a decimal in an Integer field are the usual causes.',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
      ##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read depth">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1
      1→100→.→A→T→.→.→.→GT:DP→0/1:NA
    `],
  },
  sampleEmptyField: {
    code: 'VCF408',
    title: 'Empty sample field',
    level: 'error',
    spec: 'VCF 4.3 §1.6.2',
    explanation: 'A missing value inside a sample column is written `.`, never left empty (`0/1::20`).',
    bad: [ex`
      ##fileformat=VCFv4.3
      ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
      ##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read depth">
      ##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype quality">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1
      1→100→.→A→T→.→.→.→GT:DP:GQ→0/1::20
    `],
  },
  formatKeyLegacy: {
    code: 'VCF409',
    title: 'FORMAT key is not alphanumeric (VCF 4.1/4.2)',
    level: 'off',
    strict: 'error',
    spec: 'VCF 4.2 §1.4.2',
    explanation: 'VCF 4.1 and 4.2 describe FORMAT keys as alphanumeric; `_` and `.` became legal in 4.3. Keys such as GATK\'s `MIN_DP` in files that declare 4.1/4.2 are accepted by every mainstream parser, so this is reported in strict mode only.',
    bad: [{ profile: 'strict', text: ex`
      ##fileformat=VCFv4.2
      ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
      ##FORMAT=<ID=MIN_DP,Number=1,Type=Integer,Description="Minimum depth in the block">
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→S1
      1→100→.→A→T→.→.→.→GT:MIN_DP→0/1:5
    ` }],
  },
  // ---------------------------------------------------------------- across records
  duplicateRecord: {
    code: 'VCF501',
    title: 'Duplicate record',
    level: 'warning',
    spec: 'VCF 4.3 §1.6.1',
    explanation: 'Two records have the same CHROM, POS, REF and ALT. Duplicates double-count in downstream statistics and usually come from concatenating overlapping chunks. Remove with `bcftools norm -d exact`.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
      1→100→.→A→T→.→.→.
      1→100→.→A→T→.→.→.
    `],
  },
  noRecords: {
    code: 'VCF502',
    title: 'File has a header but no records',
    level: 'info',
    explanation: 'The file is a valid header with zero variants. That is legitimate (an empty region, a sample with no calls), but it is also what a silently failed caller leaves behind.',
    bad: [ex`
      ##fileformat=VCFv4.3
      #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO
    `],
  },
});

export const GOOD_VCF_EXAMPLES: string[] = [
  GOOD_MINIMAL,
  ex`
    ##fileformat=VCFv4.3
    ##fileDate=20090805
    ##source=myImputationProgramV3.1
    ##reference=file:///seq/references/1000GenomesPilot-NCBI36.fasta
    ##contig=<ID=20,length=62435964,assembly=B36,md5=f126cdf8a6e0c7f379d618ff66beb2da,species="Homo sapiens",taxonomy=x>
    ##phasing=partial
    ##INFO=<ID=NS,Number=1,Type=Integer,Description="Number of Samples With Data">
    ##INFO=<ID=DP,Number=1,Type=Integer,Description="Total Depth">
    ##INFO=<ID=AF,Number=A,Type=Float,Description="Allele Frequency">
    ##INFO=<ID=AA,Number=1,Type=String,Description="Ancestral Allele">
    ##INFO=<ID=DB,Number=0,Type=Flag,Description="dbSNP membership, build 129">
    ##INFO=<ID=H2,Number=0,Type=Flag,Description="HapMap2 membership">
    ##FILTER=<ID=q10,Description="Quality below 10">
    ##FILTER=<ID=s50,Description="Less than 50% of samples have data">
    ##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
    ##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype Quality">
    ##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">
    ##FORMAT=<ID=HQ,Number=2,Type=Integer,Description="Haplotype Quality">
    #CHROM→POS→ID→REF→ALT→QUAL→FILTER→INFO→FORMAT→NA00001→NA00002→NA00003
    20→14370→rs6054257→G→A→29→PASS→NS=3;DP=14;AF=0.5;DB;H2→GT:GQ:DP:HQ→0|0:48:1:51,51→1|0:48:8:51,51→1/1:43:5:.,.
    20→17330→.→T→A→3→q10→NS=3;DP=11;AF=0.017→GT:GQ:DP:HQ→0|0:49:3:58,50→0|1:3:5:65,3→0/0:41:3
    20→1110696→rs6040355→A→G,T→67→PASS→NS=2;DP=10;AF=0.333,0.667;AA=T;DB→GT:GQ:DP:HQ→1|2:21:6:23,27→2|1:2:0:18,2→2/2:35:4
    20→1230237→.→T→.→47→PASS→NS=3;DP=13;AA=T→GT:GQ:DP:HQ→0|0:54:7:56,60→0|0:48:4:51,51→0/0:61:2
    20→1234567→microsat1→GTC→G,GTCT→50→PASS→NS=3;DP=9;AA=G→GT:GQ:DP→0/1:35:4→0/2:17:2→1/1:40:3
  `,
];
