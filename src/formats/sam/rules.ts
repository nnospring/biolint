import { defineRules, ex } from '../../core/rules.ts';

// How levels were chosen. "SAM v1" is the Sequence Alignment/Map Format Specification and "SAMtags" the Optional
// Fields Specification, both at hts-specs commit 510c107. Behaviour of htslib was observed with samtools 1.24.
//
//  1. htslib refuses the file                                              -> error
//  2. htslib accepts it but reads something other than what is written,
//     and the specification forbids what is written                        -> error (the explanation says what is read)
//  3. htslib accepts and preserves it, the specification says "must"
//     or gives a pattern or a range                                        -> warning, error in strict
//  4. the specification says "should" or "no assumptions can be made",
//     or the text sits in section 2 (recommended practice)                 -> warning in both profiles
//
// Exceptions, each because the value cannot be interpreted as what the field is defined to hold:
//  - an empty mandatory field is an error, although htslib keeps an empty QNAME;
//  - a FLAG in hexadecimal is an error, although htslib reads it: the field is a decimal integer, and the same
//    base-guessing parse is what turns `016` into 14;
//  - characters other than hexadecimal digits in an `H` value are an error, although htslib keeps the text;
//  - an optional field whose fifth character is not a colon is an error, although htslib does not look at that
//    character (`ML:B,C,1` is read as `ML:B:C,1`): without both colons the field is not TAG:TYPE:VALUE.
//
// Explanations state tool behaviour only where it was observed with samtools 1.24 (via pysam 0.24.1).

const HEAD = ex`
  @HD→VN:1.6→SO:unsorted
  @SQ→SN:chr1→LN:1000
`;

const GOOD_PAIR = ex`
  @HD→VN:1.6→SO:coordinate
  @SQ→SN:chr1→LN:248956422
  @RG→ID:rg1→SM:sample1→PL:ILLUMINA
  @PG→ID:bwa→PN:bwa→VN:0.7.17
  read1→99→chr1→100→60→10M→=→200→110→ACGTACGTAC→IIIIIIIIII→NM:i:0→RG:Z:rg1
  read1→147→chr1→200→60→10M→=→100→-110→ACGTACGTAC→IIIIIIIIII→NM:i:0→RG:Z:rg1
`;

const GOOD_MINIMAL = HEAD + ex`
  r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
`;

export const S = defineRules('sam', {
  // ---------------------------------------------------------------- header
  hdNotFirst: {
    code: 'SAM001',
    title: '@HD is not the first line, or appears twice',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      'A file has at most one `@HD` line and it is the very first line. A second `@HD`, or one that follows `@SQ` lines, usually means two headers were pasted together or lines were reordered by `sort` or `grep`. ' +
      'samtools reads such a file; biolint takes the sort order from the first `@HD` line.',
    bad: [
      { text: ex`
        @SQ→SN:chr1→LN:1000
        @HD→VN:1.6→SO:unsorted
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: '@HD after @SQ' },
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @HD→VN:1.6→SO:coordinate
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'two @HD lines' },
    ],
    good: [GOOD_MINIMAL],
  },
  headerTypeUnknown: {
    code: 'SAM002',
    title: 'Unknown header record type',
    level: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      'Header lines start with `@` and one of five two-letter codes in upper case: `@HD`, `@SQ`, `@RG`, `@PG` or `@CO`. New fields may be added inside these lines, but new line types may not, and samtools stops with "Invalid header line". ' +
      'A FASTQ-style read name that begins with `@` on the first alignment line is read as a header line and fails the same way.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        @XY→ID:custom
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @sq→SN:chr1→LN:1000
        r1→4→*→0→0→*→*→0→0→ACGTA→IIIII
      `, note: 'record type codes are upper case' },
    ],
  },
  headerFieldMalformed: {
    code: 'SAM003',
    title: 'Header field is not TAG:VALUE',
    level: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      'After the record type, every tab-separated field of a header line (except in `@CO`) is a two-character tag, a colon and a value, for example `SN:chr1`. A field without the colon in third position, an empty field (two tabs in a row, or a tab at the end of the line) or a line with no fields at all makes samtools stop with "Malformed key:value pair".',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000→hg38
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000→
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'a tab at the end of the line leaves an empty field' },
    ],
  },
  headerFieldIrregular: {
    code: 'SAM004',
    title: 'Header tag or value does not match the required pattern',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      'A header tag is a letter followed by a letter or digit, and its value is at least one printable ASCII character. Only the `DS` and `CL` values and `@CO` lines may contain other (UTF-8) characters, and a `@CO` line needs a tab after `@CO`. ' +
      'samtools keeps such fields as they are.',
    bad: [
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000→AS:
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'empty value' },
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000→1A:x
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'a tag starts with a letter' },
    ],
  },
  headerSpaces: {
    code: 'SAM005',
    title: 'Header fields are separated by spaces instead of tabs',
    level: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      'Header fields are separated by single tab characters. Editors that expand tabs, and copying a header out of a terminal or a web page, replace them with spaces; the line then holds one long field, required tags such as `LN` are not found, and samtools refuses the header. ' +
      'When writing a read group on a command line, the tab is spelled `\\t` inside quotes: `bwa mem -R \'@RG\\tID:x\\tSM:y\'`.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ SN:chr1 LN:1000
        r1→4→*→0→0→*→*→0→0→ACGTA→IIIII
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1 LN:1000
        r1→4→*→0→0→*→*→0→0→ACGTA→IIIII
      `, note: 'one space is enough: LN is now part of the name' },
    ],
  },
  headerTagDuplicate: {
    code: 'SAM006',
    title: 'Tag appears twice in one header line',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation: 'Within one header line each tag may be used once. With two values for the same tag, tools disagree on which one counts; samtools refuses the line only when two `LN` values differ.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000→AS:hg19→AS:hg38
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `],
  },
  headerRequiredMissing: {
    code: 'SAM007',
    title: 'Header line lacks a required tag',
    level: 'error',
    spec: 'SAM v1 §1.3',
    explanation: 'Every `@SQ` line needs `SN` (name) and `LN` (length); every `@RG` and `@PG` line needs `ID`. samtools refuses a header without them. Tags are case-sensitive, so `sn:` or `Id:` do not count.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1
        r1→4→*→0→0→*→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        @RG→SM:sample1
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
    ],
  },
  hdVersionInvalid: {
    code: 'SAM008',
    title: '@HD has no valid VN',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation: 'The `@HD` line must carry the format version as `VN:major.minor`, digits on both sides of one dot, for example `VN:1.6`. samtools does not check it.',
    bad: [
      ex`
        @HD→VN:1→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
    ],
  },
  hdSortOrderInvalid: {
    code: 'SAM009',
    title: 'Invalid SO, GO or SS value in @HD',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      '`SO` is one of `unknown`, `unsorted`, `queryname` or `coordinate`; `GO` is one of `none`, `query` or `reference`; `SS` is the `SO` value followed by one or more `:term` parts. ' +
      'The values are case-sensitive keywords: `SO:sorted` or `SO:Coordinate` is not one of them, so a tool that looks for `SO:coordinate` does not find it.',
    bad: [
      ex`
        @HD→VN:1.6→SO:sorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→GO:queryname
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
    ],
  },
  sqNameInvalid: {
    code: 'SAM010',
    title: 'Reference name contains a forbidden character',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.2.1',
    explanation:
      'Reference names are printable ASCII without spaces, backslashes, commas, quotation marks (single, double or backquote) or brackets `( ) [ ] { } < >`, and do not start with `*` or `=`. These characters are delimiters elsewhere (region strings, the `SA` tag, VCF), so a name containing them cannot be referred to unambiguously. ' +
      'The usual cause is a FASTA header whose description was kept as part of the name: align against a reference whose names stop at the first space.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1 Homo sapiens→LN:1000
        r1→4→*→0→0→*→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:contig[1]→LN:1000
        r1→4→*→0→0→*→*→0→0→ACGTA→IIIII
      `,
    ],
  },
  sqLengthInvalid: {
    code: 'SAM011',
    title: '@SQ LN is not a positive integer',
    level: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      '`LN` is the reference length in bases: digits only, at least 1. samtools refuses 0, negative values and two different `LN` values on one line, and reads `LN:1,000` or `LN:1e6` as 1, so every later range check is wrong. Thousands separators and scientific notation come from spreadsheets.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:0
        r1→4→*→0→0→*→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1,000
        r1→4→*→0→0→*→*→0→0→ACGTA→IIIII
      `,
    ],
  },
  sqLengthTooLarge: {
    code: 'SAM012',
    title: '@SQ LN exceeds 2^31-1',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation: 'The specification limits reference lengths to 2,147,483,647 bases, the largest value BAM and its BAI index can hold. samtools reads longer references from SAM text, but the file cannot be converted to BAM, and BAI indexing already stops at 2^29 (use a CSI index).',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:3000000000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `],
  },
  sqNameDuplicate: {
    code: 'SAM013',
    title: 'Two @SQ lines have the same SN',
    level: 'error',
    spec: 'SAM v1 §1.3',
    explanation: 'Reference names must be unique, because alignment records refer to references by name. samtools stops with "Duplicate entry in sam header". The cause is nearly always two headers joined with `cat`; use `samtools merge` or `samtools reheader`.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `],
  },
  sqAltNameInvalid: {
    code: 'SAM014',
    title: 'Alternative reference name (AN) is malformed or not distinct',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation: '`AN` is a comma-separated list of other names for the same sequence. Each follows the reference-name rules, and all `SN` and `AN` names in the header must differ from one another; otherwise a request for that name is ambiguous. samtools warns about the clash.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000→AN:1
        @SQ→SN:chr2→LN:900→AN:2,1
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000→AN:=
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
    ],
    good: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:MT→LN:16569→AN:chrMT,M,chrM→TP:circular
      r1→0→MT→10→30→5M→*→0→0→ACGTA→IIIII
    `],
  },
  rgIdDuplicate: {
    code: 'SAM015',
    title: 'Two @RG lines have the same ID',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation: 'Reads point at their read group through `RG:Z:<ID>`, so IDs must be unique. With duplicates samtools warns ("Duplicate entry") and it is no longer clear which sample or library a read belongs to. Joining headers by hand causes this; the specification expects merging tools to rename clashing IDs.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      @RG→ID:lane1→SM:sampleA
      @RG→ID:lane1→SM:sampleB
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→RG:Z:lane1
    `],
  },
  rgPlatformInvalid: {
    code: 'SAM016',
    title: '@RG PL is not a platform the specification lists',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      '`PL` comes from a fixed list, in upper case: `CAPILLARY`, `DNBSEQ`, `ELEMENT`, `HELICOS`, `ILLUMINA`, `IONTORRENT`, `LS454`, `ONT`, `PACBIO`, `SINGULAR`, `SOLID` and `ULTIMA`. samtools does not check the value; a tool that chooses its behaviour by platform can only recognise the listed names. ' +
      'For any other technology, leave `PL` out and describe the instrument in `PM`.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        @RG→ID:rg1→SM:sample1→PL:Nanopore
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→RG:Z:rg1
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        @RG→ID:rg1→SM:sample1→PL:454
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→RG:Z:rg1
      `, note: 'the name for 454 instruments is LS454' },
    ],
  },
  pgIdDuplicate: {
    code: 'SAM017',
    title: 'Two @PG lines have the same ID',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation: 'Each `@PG` line needs its own `ID`, because `PP` tags and the `PG` tag of reads refer to it. Tools that append a step normally add a suffix (`bwa`, `bwa.1`); identical IDs come from pasting headers together.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      @PG→ID:bwa→PN:bwa
      @PG→ID:bwa→PN:bwa
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `],
  },
  pgPreviousUnknown: {
    code: 'SAM018',
    title: '@PG PP does not point to another @PG line',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation: '`PP` names the `ID` of the program that ran before this one, which makes a chain recording the processing history. The value must be the `ID` of a different `@PG` line, anywhere in the header. A dangling or self-referring `PP` breaks the chain; samtools warns about it.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        @PG→ID:samtools→PN:samtools→PP:bwa
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        @PG→ID:bwa→PN:bwa→PP:bwa
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'a program cannot be its own predecessor' },
    ],
    good: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      @PG→ID:samtools→PN:samtools→PP:bwa
      @PG→ID:bwa→PN:bwa
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `],
  },
  headerValueInvalid: {
    code: 'SAM019',
    title: 'Header value does not have the format defined for its tag',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      'Some predefined header tags have a fixed format: `@SQ M5` is 32 lower-case hexadecimal digits, `TP` is `linear` or `circular`, `AH` is `*` or a locus such as `chr1:100-200`; `@RG DT` is an ISO 8601 date or date-time, `PI` a whole number, `FO` is `*` or IUPAC bases. ' +
      'samtools does not check these when reading a header; a malformed `M5`, for example, can never equal the checksum of the sequence.',
    bad: [
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000→M5:7FC56270E7A70FA81A5935B72EACBE29
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'M5 is written in lower case' },
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        @RG→ID:rg1→SM:sample1→DT:23/06/2020
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→RG:Z:rg1
      `,
    ],
    good: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000→M5:7fc56270e7a70fa81a5935b72eacbe29→TP:linear
      @RG→ID:rg1→SM:sample1→DT:2020-06-23T12:13:47+01:00→PI:350
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→RG:Z:rg1
    `],
  },
  headerAfterAlignment: {
    code: 'SAM020',
    title: 'Header line after the first alignment',
    level: 'error',
    spec: 'SAM v1 §1',
    explanation: 'All header lines come before the first alignment. samtools stops reading header lines at the first record, so a later `@` line is parsed as an alignment and fails. This is what `cat a.sam b.sam` produces: use `samtools merge` or `samtools cat` to join files.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      @SQ→SN:chr2→LN:900
      r2→0→chr1→20→30→5M→*→0→0→ACGTA→IIIII
    `],
  },

  headerValueGlued: {
    code: 'SAM022',
    title: 'Header value seems to contain the next field',
    level: 'warning',
    spec: 'SAM v1 §1.3',
    explanation:
      'A value such as `ID:rg1 SM:sample1` is legal as far as the pattern goes (values may contain spaces), but it almost certainly means a tab was typed or pasted as a space: tools take the whole text as the ID, so reads tagged `RG:Z:rg1` no longer match, and the sample name is lost. ' +
      'Some programs write their own `@PG` line this way. Only tags predefined for the record type are recognised after the space; `DS` and `CL` values are not examined.',
    bad: [{ text: ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      @RG→ID:rg1 SM:sample1
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `, note: 'the read group ID is read as "rg1 SM:sample1"' }],
    good: [{ text: ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      @RG→ID:rg1→SM:sample 1→DS:made with PL:ILLUMINA kit
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `, note: 'spaces inside a value are fine' }],
  },
  rgPlatformCase: {
    code: 'SAM023',
    title: '@RG PL is not written in upper case',
    level: 'info',
    strict: 'warning',
    spec: 'SAM v1 §1.3',
    explanation: 'The platform names are defined in upper case (`ILLUMINA`, `ONT`, `PACBIO`, ...). The specification asks writers to use exactly that spelling and readers to accept lower case as well, because many public files contain `PL:illumina`; a tool that compares the value exactly will not recognise it.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      @RG→ID:rg1→SM:sample1→PL:illumina
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→RG:Z:rg1
    `],
  },
  blankLine: {
    code: 'SAM021',
    title: 'Blank line',
    level: 'error',
    spec: 'SAM v1 §1',
    explanation:
      'Every line of a SAM file is either a header line starting with `@` or an alignment with eleven fields; there are no empty lines. samtools reads a blank line as an alignment with no fields and stops with "Parse error", even when the blank line is the last line of the file. ' +
      'Editors and `echo` add them easily. Trailing blank lines are removed by `biolint --fix`.',
    bad: [
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII

        r2→0→chr1→20→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'between two records' },
      { text: '@HD\tVN:1.6\tSO:unsorted\n@SQ\tSN:chr1\tLN:1000\nr1\t0\tchr1\t10\t30\t5M\t*\t0\t0\tACGTA\tIIIII\n\n', note: 'at the end of the file' },
    ],
  },

  // ---------------------------------------------------------------- alignment lines: the eleven mandatory fields
  tooFewFields: {
    code: 'SAM101',
    title: 'Alignment line has fewer than 11 tab-separated fields',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation:
      'Every alignment line has eleven mandatory fields separated by single tabs: QNAME, FLAG, RNAME, POS, MAPQ, CIGAR, RNEXT, PNEXT, TLEN, SEQ and QUAL. A field with nothing to say holds `*` or `0`; it is never left out. ' +
      'Short lines come from tabs turned into spaces, or from a file cut off while it was being written.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1 0 chr1 10 30 5M * 0 0 ACGTA IIIII
      `, note: 'spaces instead of tabs' },
    ],
    good: [GOOD_MINIMAL, GOOD_PAIR],
  },
  fieldEmpty: {
    code: 'SAM102',
    title: 'Mandatory field is empty',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation: 'None of the eleven mandatory fields may be empty. Missing information is written as `*` (QNAME, RNAME, CIGAR, RNEXT, SEQ, QUAL) or `0` (FLAG, POS, MAPQ, PNEXT, TLEN). Two tabs in a row usually come from a script that printed an undefined value.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→→0→0→ACGTA→IIIII
    `],
  },
  qnameInvalid: {
    code: 'SAM103',
    title: 'Read name contains a character that is not allowed',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.2.1',
    explanation:
      'A read name (QNAME) is 1 to 254 printable ASCII characters without spaces and without `@`, so that alignment lines can never be mistaken for header lines. ' +
      'A leading `@` is left over from a FASTQ header; a space means the FASTQ comment was not removed. samtools keeps such names, but a name starting with `@` on the first alignment line is read as a header line.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
        @read2→0→chr1→20→30→5M→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        read1 1:N:0:ACGT→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
    ],
  },
  qnameTooLong: {
    code: 'SAM104',
    title: 'Read name is longer than 254 characters',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation: 'Read names are limited to 254 characters because BAM stores the length in one byte. samtools stops with "query name too long". Shorten the names before alignment, for example by dropping the FASTQ comment.',
    bad: [`${HEAD}${'r'.repeat(255)}\t0\tchr1\t10\t30\t5M\t*\t0\t0\tACGTA\tIIIII\n`],
  },
  flagInvalid: {
    code: 'SAM105',
    title: 'FLAG is not a decimal integer from 0 to 65535',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation:
      'FLAG is a whole number in decimal whose bits describe the read (paired, unmapped, reverse strand, ...). samtools refuses negative, non-numeric and too large values. It reads a leading zero as octal, so `016` becomes 14, and it accepts `0x10` although the field is defined as a decimal number: write plain decimal.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→65536→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→016→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'read as octal 14 by samtools' },
    ],
  },
  flagInconsistent: {
    code: 'SAM106',
    title: 'FLAG bits contradict each other or are reserved',
    level: 'warning',
    spec: 'SAM v1 §1.4',
    explanation:
      'Three combinations are reported, each resting on one item of the list that follows the FLAG table. ' +
      '(1) Bit 0x1 (paired) unset while 0x2, 0x8, 0x20, 0x40 or 0x80 is set. Basis: the item beginning "If 0x1 is unset", which says nothing may be assumed about those five bits, so they carry no information. ' +
      '(2) Bit 0x4 (unmapped) set together with 0x2, 0x100 or 0x800. Basis: the item on bit 0x4, whose second sentence says that when it is set nothing may be assumed about those three bits. ' +
      '(3) A bit above 0x800. Basis: the last item, which reserves unlisted bits and asks writers to leave them unset. ' +
      'The same items ask readers to ignore such bits rather than fail, so this is a warning in both profiles.',
    bad: [
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→66→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: '66 = 0x2 + 0x40 without 0x1' },
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→260→*→0→0→*→*→0→0→ACGTA→IIIII
      `, note: '260 = unmapped + secondary' },
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→4096→chr1→10→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'bit 0x1000 is not defined' },
    ],
  },
  rnameInvalid: {
    code: 'SAM107',
    title: 'RNAME or RNEXT contains a forbidden character',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.2.1',
    explanation: 'RNAME and RNEXT follow the same rules as `@SQ SN`: printable ASCII without spaces, backslashes, commas, quotation marks or brackets, not starting with `*` or `=`. (`*` alone means "none", and `=` alone in RNEXT means "same as RNAME".) samtools keeps such names; region strings and the `SA` tag cannot express them.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1,alt→LN:1000
      r1→0→chr1,alt→10→30→5M→*→0→0→ACGTA→IIIII
    `],
  },
  rnameUnknown: {
    code: 'SAM108',
    title: 'Reference name is not declared in an @SQ line',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation:
      'When the header has `@SQ` lines, every RNAME and RNEXT (other than `*` and `=`) must be the `SN` of one of them. samtools warns "unrecognized reference name; treated as unmapped" and drops the position, so the read silently disappears from every region query. ' +
      'The usual cause is a header taken from a different reference build (`chr1` versus `1`), or names that keep the FASTA description.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→1→10→30→5M→*→0→0→ACGTA→IIIII
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→65→chr1→10→30→5M→chrM→20→0→ACGTA→IIIII
      `, note: 'the mate reference (RNEXT) is checked too' },
    ],
  },
  rnameIsAlias: {
    code: 'SAM125',
    title: 'RNAME or RNEXT uses an alternative name instead of the SN',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation: 'The names listed in `@SQ AN` let tools accept `chrM` when a user asks for `MT`, for example. They are not used inside the file: records must name a reference by its `SN`. samtools resolves the alias and writes the `SN` back, so the file changes on conversion; tools that look names up exactly do not find the reference.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:MT→LN:16569→AN:chrM
      r1→0→chrM→10→30→5M→*→0→0→ACGTA→IIIII
    `],
  },
  noSqHeader: {
    code: 'SAM109',
    title: 'Mapped reads but no @SQ lines',
    level: 'error',
    strict: 'warning',
    spec: 'SAM v1 §2',
    explanation:
      'The header is optional in the specification, which only recommends `@SQ` lines when reads are mapped. In practice samtools cannot read a mapped record without them ("no SQ lines present in the header"), because BAM stores references by number. ' +
      'The file was probably written without its header (`samtools view` without `-h`, `bowtie2 --no-hd`). Supply the reference when reading (`samtools view -t ref.fa.fai`) or regenerate the file with its header. Reported once per file.',
    bad: [ex`
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `],
    good: [{ text: ex`
      r1→4→*→0→0→*→*→0→0→ACGTA→IIIII
    `, note: 'unaligned reads need no header' }],
  },
  posInvalid: {
    code: 'SAM110',
    title: 'POS or PNEXT is not a non-negative integer',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation: 'POS and PNEXT are 1-based positions written as whole numbers; 0 means "no position". Negative numbers, decimals, `*` and scientific notation (a spreadsheet artefact) make samtools stop with a parse error.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→-1→30→5M→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→*→0→ACGTA→IIIII
      `,
    ],
  },
  coordinateRange: {
    code: 'SAM111',
    title: 'POS, PNEXT or TLEN does not fit in 32 bits',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.4',
    explanation: 'POS and PNEXT may be at most 2^31-1 (2,147,483,647) and TLEN lies between -(2^31-1) and 2^31-1. samtools reads larger values from SAM text, but they cannot be stored in BAM, and no reference allowed by the specification is that long.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→3000000000→ACGTA→IIIII
    `],
  },
  posBeyondReference: {
    code: 'SAM112',
    title: 'Alignment lies beyond the end of its reference',
    level: 'warning',
    spec: 'SAM v1 §2',
    explanation:
      'POS, or the last base the CIGAR covers, is larger than the `LN` of the reference in the header. The specification recommends that such a read be flagged unmapped (unless the reference is circular, `TP:circular`). ' +
      'It nearly always means the header describes a different reference build than the one the reads were aligned to.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→2000→30→5M→*→0→0→ACGTA→IIIII
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→998→30→5M→*→0→0→ACGTA→IIIII
      `, note: 'the alignment starts inside the reference and runs past its end' },
    ],
  },
  mapqInvalid: {
    code: 'SAM113',
    title: 'MAPQ is not an integer from 0 to 255',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation: 'Mapping quality is a whole number from 0 to 255, where 255 means "not available". Write 0 or 255 rather than `*` or a decimal when the aligner gives no value.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→256→5M→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→*→5M→*→0→0→ACGTA→IIIII
      `,
    ],
  },
  cigarInvalid: {
    code: 'SAM114',
    title: 'CIGAR is malformed',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation:
      'A CIGAR is `*` or a series of length-operation pairs such as `76M` or `5S60M2D11M`. The operations are `M I D N S H P = X`, in upper case, each preceded by its length, and a length must be below 2^28 (the BAM limit). ' +
      'samtools stops at an unknown operation, a missing length or a trailing number. (The obsolete `B` operation, which samtools still reads, is reported separately.)',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5m→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→M5→*→0→0→ACGTA→IIIII
      `,
    ],
  },
  cigarClipping: {
    code: 'SAM115',
    title: 'Clipping operation in the middle of a CIGAR',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.4',
    explanation: 'Clipping describes the ends of a read: `H` (hard clip) may only be the first or last operation, and `S` (soft clip) may only have `H` between it and the end of the CIGAR. Inside an alignment, use `I` for bases missing from the reference or `N` for a skipped region. samtools does not check this.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→2M1S2M→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→1S2H4M→*→0→0→ACGTA→IIIII
      `,
    ],
    good: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→3H1S3M1S2H→*→0→0→ACGTA→IIIII
    `],
  },
  cigarSeqLength: {
    code: 'SAM116',
    title: 'CIGAR and SEQ describe different read lengths',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation:
      'The lengths of the `M`, `I`, `S`, `=` and `X` operations add up to the number of bases in SEQ (when SEQ is not `*`). `D`, `N`, `H` and `P` do not count. samtools stops with "CIGAR and query sequence are of different length". ' +
      'Typical causes: SEQ was trimmed after alignment, hard-clipped bases were left in SEQ, or the line was truncated.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→6M→*→0→0→ACGTA→IIIII
    `],
    good: [{ text: ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→2M3D1I2M→*→0→0→ACGTA→IIIII
    `, note: 'D does not consume read bases' }],
  },
  tlenInvalid: {
    code: 'SAM117',
    title: 'TLEN is not an integer',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation: 'TLEN (observed template length) is a signed whole number, 0 when unknown. Decimals and `*` are parse errors in samtools.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→*→ACGTA→IIIII
    `],
  },
  seqInvalid: {
    code: 'SAM118',
    title: 'SEQ contains a character that is not a base code',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation:
      'SEQ is `*` or a string of letters, `=` (same as the reference) and `.`. Digits, `-`, `*` inside a sequence and spaces are not bases. samtools does not stop: it stores an arbitrary base code instead (`AC1TA` is read back as `ACCTA`), so the sequence is silently changed. ' +
      'Gap characters come from aligned (padded) sequences pasted into SEQ; gaps belong in the CIGAR.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→AC-TA→IIIII
      `,
    ],
  },
  seqNotStorable: {
    code: 'SAM119',
    title: 'SEQ uses letters that BAM cannot store',
    level: 'warning',
    spec: 'SAM v1 §4.2.3',
    explanation: 'SAM text allows any letter and `.` in SEQ, but BAM encodes only `=ACMGRSVTWYHKDBN`. samtools reads `U` as `T` and every other letter, and `.`, as `N`, without a message, so the sequence changes on conversion. Write RNA as `T` and unknown bases as `N`.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGUA→IIIII
    `],
  },
  qualLength: {
    code: 'SAM120',
    title: 'QUAL and SEQ have different lengths',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation: 'QUAL holds one character per base of SEQ, or `*` when qualities are not stored; it cannot be given when SEQ is `*`. samtools stops with "SEQ and QUAL are of different length". Trimming one field and not the other, and truncated lines, cause this.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIII
      `,
      { text: ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→*→IIIII
      `, note: 'qualities without a sequence' },
    ],
    good: [{ text: ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→*
    `, note: 'QUAL may be * when qualities are not stored' }],
  },
  qualInvalid: {
    code: 'SAM121',
    title: 'QUAL contains a character outside the Phred+33 range',
    level: 'error',
    spec: 'SAM v1 §1.4',
    explanation: 'Each quality is one printable character from `!` (0) to `~` (93): the Phred score plus 33. A space or a non-ASCII byte is not a quality; samtools stops with "invalid QUAL character".',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→II II
    `],
  },
  integerFormat: {
    code: 'SAM122',
    title: 'Integer field has a plus sign or leading zeros',
    level: 'warning',
    spec: 'SAM v1 §1.4',
    explanation: 'POS, MAPQ, PNEXT and TLEN are integers. The specification gives their range but not their spelling, and samtools reads `+200` and `007` as 200 and 7. Another parser may not: samtools itself reads a leading zero in FLAG as octal. Write the plain decimal number.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→010→30→5M→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→+200→ACGTA→IIIII
      `,
    ],
  },
  mappedIncomplete: {
    code: 'SAM123',
    title: 'Read is flagged as mapped but has no position or CIGAR',
    level: 'warning',
    spec: 'SAM v1 §1.4',
    explanation:
      'The unmapped bit (0x4) is not set, yet RNAME is `*`, POS is 0 or CIGAR is `*`. The specification allows this and only says that nothing may be assumed about the other fields; samtools treats the record as unmapped and says so ("treated as unmapped"), which changes its FLAG on conversion. ' +
      'Set flag bit 4 for reads that were not aligned.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→*→*→0→0→ACGTA→IIIII
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→*→0→0→*→*→0→0→ACGTA→IIIII
      `,
    ],
  },

  cigarBackOperation: {
    code: 'SAM124',
    title: 'CIGAR uses the obsolete B operation',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.4',
    explanation: '`B` ("back": move backwards along the reference) is not among the operations the specification lists (`M I D N S H P = X`). samtools still reads and writes it, so the file passes there, but a tool written from the specification has no meaning for it. biolint does not compare such a CIGAR with SEQ.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→3M1B3M→*→0→0→ACGTAC→IIIIII
    `],
  },

  // ---------------------------------------------------------------- alignment lines: optional fields
  auxMalformed: {
    code: 'SAM201',
    title: 'Optional field is not TAG:TYPE:VALUE',
    level: 'error',
    spec: 'SAM v1 §1.5',
    explanation: 'Fields after the eleventh are `TAG:TYPE:VALUE`: a two-character tag, a one-letter type and a value, for example `NM:i:2`. A missing type (`NM:2`), a tag of another length or an empty field between two tabs stops samtools with "incomplete aux field". (samtools does not look at the character after the type, so it reads `ML:B,C,1` as `ML:B:C,1`; the field is reported all the same.)',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→NM:2
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→NM:i:2→→AS:i:5
      `,
    ],
    good: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→NM:i:2→XS:A:+→de:f:0.02→MD:Z:5→XH:H:1AE301→ZB:B:s,-5,12→CO:Z:
    `],
  },
  trailingTab: {
    code: 'SAM202',
    title: 'Alignment line ends with a tab',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.5',
    explanation: 'A tab at the end of the line starts an optional field that is empty. samtools ignores it; a parser that splits on tabs finds a field that is not `TAG:TYPE:VALUE`. Scripts that append a tab after every field cause this.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→NM:i:0→
    `],
  },
  auxTagInvalid: {
    code: 'SAM203',
    title: 'Optional field tag is not a letter followed by a letter or digit',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.5',
    explanation: 'Tags are exactly two characters: a letter, then a letter or digit (`NM`, `X0`, `tp`). samtools keeps other tags as they are.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→1A:i:5
    `],
  },
  auxTypeUnknown: {
    code: 'SAM204',
    title: 'Unknown optional field type',
    level: 'error',
    spec: 'SAM v1 §1.5',
    explanation:
      'The type is one case-sensitive letter: `A` (character), `i` (integer), `f` (number), `Z` (string), `H` (hex bytes) or `B` (numeric array). The letters `c C s S` are sizes used inside BAM; in SAM text every integer is `i`. ' +
      'samtools rejects most other letters and misreads some (`XC:c:5` is stored as the character "5"). The two letters it reads correctly, `I` and `d`, are reported by a separate rule.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→XS:z:text
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→NM:S:2
      `,
    ],
  },
  auxValueInvalid: {
    code: 'SAM205',
    title: 'Optional field value does not fit its type',
    level: 'error',
    spec: 'SAM v1 §1.5',
    explanation:
      'The value must fit the declared type: `A` is exactly one character; `i` is an integer from -2^31 to 2^32-1; `f` is a number; `H` is an even number of hexadecimal digits; `B` is an element type (`c C s S i I f`) followed by comma-separated numbers. ' +
      'samtools stops on some of these and silently changes others: `XI:i:1.5` is read as 1, `XI:i:abc` as 0, `XA:A:ab` as `a`, and an empty array element as 0.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→NM:i:1.5
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→XB:B:i,1,,3
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→XH:H:ABC
      `,
    ],
  },
  auxValueNonstandard: {
    code: 'SAM206',
    title: 'Optional field value is outside the pattern for its type',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.5',
    explanation:
      'The value can be read, and samtools keeps it, but it is not what the specification allows for the type: `nan`, `inf` or `5.` for `f` (the pattern needs digits after the point); a number too large for single precision; lower-case digits in `H`; a space or non-ASCII character in `A`, or non-ASCII in `Z`; a `B` element outside the range of its element type (samtools changes the element type to fit). ' +
      'A parser that applies the specification\'s patterns rejects these.',
    bad: [
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→XF:f:nan
      `,
      ex`
        @HD→VN:1.6→SO:unsorted
        @SQ→SN:chr1→LN:1000
        r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→XB:B:C,256
      `,
    ],
  },
  auxTagDuplicate: {
    code: 'SAM207',
    title: 'Tag appears twice in one alignment line',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.5',
    explanation: 'Each tag may appear once per record. samtools keeps both copies, and a lookup by tag (tried with pysam) returns the first, so the second value is never seen. Pipelines that add a tag without removing the old one cause this.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→NM:i:0→AS:i:5→NM:i:1
    `],
  },
  auxTypeMismatch: {
    code: 'SAM208',
    title: 'Predefined tag used with the wrong type',
    level: 'warning',
    strict: 'error',
    spec: 'SAMtags §1',
    explanation: 'Tags in upper case that do not start with X, Y or Z are defined by the specification, each with one type: `NM:i`, `MD:Z`, `RG:Z`, `AS:i`, `SA:Z`, `ML:B` and so on. A tool that expects the edit distance in `NM` as an integer cannot use `NM:Z:2`. For your own data use a lower-case tag or one starting with X, Y or Z.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→NM:Z:2
    `],
  },
  rgUndeclared: {
    code: 'SAM209',
    title: 'RG tag names a read group the header does not define',
    level: 'warning',
    strict: 'error',
    spec: 'SAMtags §1.2',
    explanation: 'When the header has `@RG` lines, the value of every `RG:Z:` tag must be the `ID` of one of them. Reads with an unknown read group have no sample or library. The header was probably replaced (`samtools reheader`) or the files were merged without their read groups.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      @RG→ID:lane1→SM:sampleA
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→RG:Z:lane2
    `],
  },
  pgUndeclared: {
    code: 'SAM210',
    title: 'PG tag names a program the header does not define',
    level: 'warning',
    strict: 'error',
    spec: 'SAMtags §1.2',
    explanation: 'When the header has `@PG` lines, the value of a `PG:Z:` tag is the `ID` of one of them: it says which program produced the record. An unknown ID usually means the header was replaced or the `@PG` lines were filtered out.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      @PG→ID:bwa→PN:bwa
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→PG:Z:bowtie2
    `],
  },
  rgHeaderMissing: {
    code: 'SAM211',
    title: 'Reads carry RG tags but the header has no @RG lines',
    level: 'warning',
    spec: 'SAM v1 §2',
    explanation: 'The specification recommends one `@RG` line for every read group named by an `RG:Z:` tag. Without it the read group has no sample, library or platform. Reported once per file.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→RG:Z:lane1
    `],
  },

  auxTypeBamOnly: {
    code: 'SAM212',
    title: 'Optional field uses a BAM-only type letter',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.5',
    explanation: '`I` (unsigned 32-bit integer) and `d` (double) are type codes of the BAM encoding, not of SAM text, where integers are `i` and numbers are `f`. samtools reads `XX:I:5` as the integer 5 and keeps `XX:d:` values, so the file works there; parsers that follow the specification reject the record.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII→AS:I:50
    `],
  },

  // ---------------------------------------------------------------- whole file
  notCoordinateSorted: {
    code: 'SAM301',
    title: 'Header says SO:coordinate but records are out of order',
    level: 'warning',
    strict: 'error',
    spec: 'SAM v1 §1.3',
    explanation:
      'A coordinate-sorted file lists records by reference, in the order of the `@SQ` lines, then by POS; records with RNAME `*` come last. `samtools index` stops with "Unsorted positions" on such a file once it is converted to BAM. ' +
      'The header was probably copied from a sorted file, or records were appended afterwards. Run `samtools sort`. Only the first out-of-order record is reported.',
    bad: [ex`
      @HD→VN:1.6→SO:coordinate
      @SQ→SN:chr1→LN:1000
      r1→0→chr1→100→30→5M→*→0→0→ACGTA→IIIII
      r2→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `],
    good: [GOOD_PAIR],
  },
  notQuerynameSorted: {
    code: 'SAM302',
    title: 'Header says SO:queryname but read names are not in order',
    level: 'warning',
    spec: 'SAM v1 §1.3',
    explanation:
      'The specification does not fix one ordering for `SO:queryname`, only that it be applied consistently, and notes that libraries differ: `samtools sort -n` orders names "naturally" (`read9` before `read10`), while a plain character-by-character order puts `read10` first. ' +
      'This is reported when the names follow neither order (or not the one named by `SS:queryname:natural` or `SS:queryname:lexicographical`), so mates are probably not adjacent. Run `samtools sort -n`. Only the first out-of-order record is reported.',
    bad: [ex`
      @HD→VN:1.6→SO:queryname
      @SQ→SN:chr1→LN:1000
      readB→0→chr1→100→30→5M→*→0→0→ACGTA→IIIII
      readA→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `],
    good: [{ text: ex`
      @HD→VN:1.6→SO:queryname
      @SQ→SN:chr1→LN:1000
      read9→0→chr1→100→30→5M→*→0→0→ACGTA→IIIII
      read10→0→chr1→10→30→5M→*→0→0→ACGTA→IIIII
    `, note: 'natural order, as written by samtools sort -n' }],
  },
  noAlignments: {
    code: 'SAM303',
    title: 'Header without alignment records',
    level: 'info',
    explanation: 'The file has header lines and nothing else. That is a valid SAM file (it is what `samtools view -H` prints), but if reads were expected, the aligner produced none or the file was cut off after the header.',
    bad: [ex`
      @HD→VN:1.6→SO:unsorted
      @SQ→SN:chr1→LN:1000
    `],
  },
});

/** Valid files that must stay free of diagnostics in both profiles. */
export const GOOD_SAM_EXAMPLES: string[] = [
  GOOD_MINIMAL,
  GOOD_PAIR,
  ex`
    @HD→VN:1.6→SO:queryname
    @SQ→SN:chr1→LN:248956422
    @SQ→SN:chrM→LN:16569→TP:circular→M5:c68f52674c9fb33aef52dcf399755519
    @RG→ID:lane1→SM:NA12878→LB:lib1→PL:ILLUMINA→PU:HXXXX.1→DT:2023-04-01
    @PG→ID:bwa→PN:bwa→VN:0.7.17→CL:bwa mem -t 8 ref.fa r1.fq r2.fq
    @PG→ID:samtools→PN:samtools→PP:bwa→VN:1.19
    @CO→free text with a TAB:like word
    read1→83→chr1→200→60→10M→=→100→-110→ACGTACGTAC→IIIIIIIIII→NM:i:0→MD:Z:10→AS:i:10→RG:Z:lane1→PG:Z:bwa
    read1→163→chr1→100→60→4S6M→=→200→110→ACGTACGTAC→IIIIIIIIII→NM:i:0→MD:Z:6→RG:Z:lane1→SA:Z:chrM,5,+,4M6S,60,0;
    read1→2209→chrM→5→60→4M6H→chr1→200→0→ACGT→IIII→NM:i:0→RG:Z:lane1
    read2→77→*→0→0→*→*→0→0→ACGTN→!!!!!→RG:Z:lane1→YT:Z:UP
    read2→141→*→0→0→*→*→0→0→*→*→RG:Z:lane1
    read3→16→chrM→16560→255→5M3N5M2D3M1I2=1X→*→0→0→ACGTACGTACGTACGTA→*→XB:B:C,0,255→XF:f:-1.5e-3→ML:B:C
  `,
];
