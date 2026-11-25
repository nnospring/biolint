import { defineRules, ex } from '../../core/rules.ts';

const SPEC = 'BED v1.0';

const GOOD_BED3 = ex`
  chr1→1000→5000
  chr1→7000→7250
  chr2→0→300
`;

const GOOD_BED6 = ex`
  # peaks called on 2024-03-01
  chr7→127471196→127472363→Pos1→0→+
  chr7→127472363→127473530→Pos2→0→+
  chr7→127475864→127477031→Neg1→0→-
`;

const GOOD_BED12 = ex`
  chr22→1000→5000→cloneA→960→+→1000→5000→0→2→567,488,→0,3512
  chr22→2000→6000→cloneB→900→-→2000→6000→0→2→433,399,→0,3601
`;

/** Files that must produce no diagnostics at all, in either profile. */
export const GOOD_BED_EXAMPLES = [GOOD_BED3, GOOD_BED6, GOOD_BED12];

export const B = defineRules('bed', {
  // ---------------------------------------------------------------- what kind of file is this
  otherFormat: {
    code: 'BED001',
    title: 'File holds another format, not BED',
    level: 'error',
    explanation:
      'The name says BED but the content is something else. The commonest case is a PLINK binary genotype file: PLINK also uses the `.bed` extension, for a binary matrix that has nothing to do with genome-browser BED. ' +
      'It also happens when a GFF, VCF, SAM or FASTA file is renamed by mistake. Nothing else is checked in such a file.',
    bad: [{ text: ex`
      ##gff-version 3
      chr1→.→gene→1000→5000→.→+→.→ID=gene1
    `, note: 'a GFF3 file saved with a .bed name' }],
  },
  trackLine: {
    code: 'BED002',
    title: 'File contains browser or track lines',
    level: 'info',
    strict: 'error',
    spec: `${SPEC} §5`,
    explanation:
      '`browser` and `track` lines configure the UCSC Genome Browser. Genome browsers accept them at the top of a file, but the specification calls such a file a *track file*, not a BED file, ' +
      'and a parser that expects plain BED reads these lines as data. Remove them, or keep the annotated copy for the browser only.',
    bad: [ex`
      track name="peaks" description="ChIP-seq peaks" useScore=1
      chr1→1000→5000→peak1→960
    `],
    good: [GOOD_BED6],
  },
  trackLineMisplaced: {
    code: 'BED003',
    title: 'browser or track line after data lines',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC} §5`,
    explanation:
      'Browser and track lines belong before the data. A `track` line in the middle starts a second track, which only the UCSC Genome Browser understands; a `browser` line in the middle has no defined meaning. ' +
      'This is usually the result of joining two custom-track files with `cat`. biolint checks each track separately from this point on.',
    bad: [ex`
      chr1→1000→5000
      browser position chr1:1-10000
      chr1→7000→7250
    `],
  },
  headerLine: {
    code: 'BED004',
    title: 'Column header line is not commented out',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC} §1.4`,
    explanation:
      'BED has no column header. A first line such as `chrom start end` is read as a feature whose start is the word "start", so parsers stop there or carry a bogus feature along; a few tools skip some header spellings, which hides the problem until another tool is used. ' +
      'Spreadsheets and `write.table(..., col.names = TRUE)` add such a line. Delete it, or turn it into a comment by starting it with `#`.',
    bad: [ex`
      chrom→start→end→name
      chr1→1000→5000→geneA
    `],
    good: [ex`
      #chrom→start→end→name
      chr1→1000→5000→geneA
    `],
  },
  blankLine: {
    code: 'BED005',
    title: 'Blank line between data lines',
    level: 'warning',
    strict: 'info',
    spec: `${SPEC} §1.4.2`,
    explanation:
      'The specification allows blank lines anywhere, but not every parser follows it: a reader may stop at the first empty line, or report a malformed record. ' +
      'A line that looks empty but contains spaces or tabs is worse, because tab-based parsers see fields in it. Delete blank lines.',
    bad: [ex`
      chr1→1000→5000

      chr1→7000→7250
    `],
  },
  leadingWhitespace: {
    code: 'BED006',
    title: 'Line starts with a space or tab',
    level: 'error',
    spec: `${SPEC} §1.4`,
    explanation:
      'A data line starts with the chromosome name and a comment starts with `#`, in the first column in both cases. With whitespace in front, tab-based parsers read an empty chromosome name and every field is shifted by one column; ' +
      'an indented `#` line is not a comment at all. Indentation usually comes from pasting out of a document or e-mail.',
    bad: [ex`
      chr1→1000→5000
      →chr1→7000→7250
    `],
  },
  trailingWhitespace: {
    code: 'BED007',
    title: 'Line ends with a space or tab',
    level: 'warning',
    explanation:
      'A tab at the end of a line adds an empty last field, and a trailing space becomes part of the last value (`+ ` is not a strand). Spreadsheet exports and hand editing leave these behind. ' +
      'Some parsers ignore them and others count an extra column, so the same file behaves differently from tool to tool.',
    bad: [ex`
      chr1→1000→5000→geneA
      chr1→7000→7250→geneB→
    `],
  },
  spaceSeparated: {
    code: 'BED008',
    title: 'Fields are separated by spaces, not tabs',
    level: 'warning',
    spec: `${SPEC} §1.3, §3.5`,
    explanation:
      'The specification accepts any run of spaces and tabs between fields, and the UCSC Genome Browser reads such files. Tools built around tab-separated text do not: bedtools documents that its input must be tab-delimited, tabix indexes tab-delimited files only, and table readers told to split on tabs ' +
      'see one column per line. The specification itself recommends a single tab. Space-separated files usually come from copying an example off a web page or from an editor that converts tabs to spaces.',
    bad: [ex`
      chr1 1000 5000
      chr1 7000 7250
    `],
    good: [GOOD_BED3],
  },
  mixedSeparators: {
    code: 'BED009',
    title: 'Separators differ from the rest of the file',
    level: 'error',
    strict: 'warning',
    spec: `${SPEC} §1.3, §3.5`,
    explanation:
      'The file separates fields with single tabs, but here a space, a space next to a tab, or two tabs in a row is used instead. Read to the letter, the specification allows any run of spaces and tabs (which is why this is only a warning in the strict profile), ' +
      'but tab-based tools take the stray space as part of the value: `chr1 ` is not chromosome `chr1`, and a line separated by spaces has one field. The result is a failure or, worse, features silently dropped. An editor replacing a tab with spaces on one edited line is the usual cause.',
    bad: [
      { text: ex`
        chr1→1000→5000
        chr1 7000 7250
      `, note: 'the second line uses spaces' },
      { text: ex`
        chr1→1000→5000
        chr1 →7000→7250
      `, note: 'a space before the tab' },
    ],
  },
  tooFewFields: {
    code: 'BED010',
    title: 'Line has fewer than three fields',
    level: 'error',
    spec: `${SPEC} §1.5`,
    explanation:
      'Every data line needs at least a chromosome, a start and an end. A line with one or two fields usually means the file is separated by something other than tabs (commas, semicolons), ' +
      'or that it lists regions as `chr1:1000-5000`, which is a different notation with different coordinates.',
    bad: [
      { text: ex`
        chr1:1001-5000
      `, note: 'a region string, not BED' },
      { text: ex`
        chr1,1000,5000
      `, note: 'comma-separated' },
    ],
  },
  fieldCount: {
    code: 'BED011',
    title: 'Line has a different number of fields than the first data line',
    level: 'error',
    spec: `${SPEC} §1.5`,
    explanation:
      'All data lines of a BED file must have the same number of fields. Parsers decide how to read the whole file from one line, so a short or long line is rejected or misread. ' +
      'Typical causes are a missing value (write `.` instead of leaving it out), a tab inside a name, or two files with different layouts joined with `cat`.',
    bad: [ex`
      chr1→1000→5000→geneA
      chr1→7000→7250
    `],
  },
  emptyField: {
    code: 'BED012',
    title: 'Standard field is empty',
    level: 'error',
    spec: `${SPEC} §1.5`,
    explanation:
      'A standard BED field that is filled on one line must not be empty on another. Two tabs in a row leave an empty value between them; tools either reject the line or shift the remaining values one column to the left. ' +
      'Write `.` for an unknown name or strand and `0` for an unknown score.',
    bad: [ex`
      chr1→1000→5000→geneA→0→+
      chr1→7000→7250→→0→-
    `],
  },
  customColumns: {
    code: 'BED013',
    title: 'Some columns are read as custom fields',
    level: 'info',
    spec: `${SPEC} §4`,
    explanation:
      'A BED file has 3 to 12 standard fields, optionally followed by custom fields (written BED6+4 for six standard and four custom fields), and nothing inside the file says where the standard fields end. ' +
      'biolint reads the longest run of leading columns that fit the standard definitions on the first data line as standard and treats the rest as custom fields, which are not checked. ' +
      'ENCODE narrowPeak and broadPeak files come out as BED6+4 and BED6+3 this way, and a four-column bedGraph as BED4 (its value sits where a name would, and any text is a valid name). If the reading is not what you intended, the message names the value that stopped it; declare the layout with `--option bed.type=bed6+4` to override it.',
    bad: [{ text: ex`
      chr1→9356548→9356648→peak1→0→.→182.2→5.0945→-1→50
      chr1→9358722→9358822→peak2→0→.→91.5→4.6052→-1→40
    `, note: 'a narrowPeak file: column 7 is a signal value, not thickStart' }],
    good: [GOOD_BED6],
  },
  blocksIncomplete: {
    code: 'BED014',
    title: 'Block fields are incomplete (BED10 or BED11)',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC} §1.5`,
    explanation:
      'The three block fields (blockCount, blockSizes, blockStarts) only make sense together, so the specification prohibits files with 10 or 11 standard fields. ' +
      'This file has 10 or 11 columns and the last ones look like the beginning of a block description, as if the final columns were cut off. If those columns are custom fields of your own (BED9+1 or BED9+2), the file is fine and this can be ignored.',
    bad: [ex`
      chr22→1000→5000→cloneA→960→+→1000→5000→0→2
      chr22→2000→6000→cloneB→900→-→2000→6000→0→2
    `],
    good: [GOOD_BED12],
  },
  quotedField: {
    code: 'BED015',
    title: 'Value is wrapped in quotation marks',
    level: 'error',
    spec: `${SPEC} §1.5`,
    explanation:
      'BED has no quoting: a quotation mark is part of the value, so `"chr1"` is a chromosome that exists in no genome and `"1000"` is not a number. ' +
      'Quotes are added by R (`write.table` quotes text columns unless `quote = FALSE`) and by CSV exports from spreadsheets.',
    bad: [ex`
      "chr1"→1000→5000
    `],
  },

  // ---------------------------------------------------------------- chrom, chromStart, chromEnd
  chromName: {
    code: 'BED020',
    title: 'Chromosome name has characters outside letters, digits and underscore',
    level: 'off',
    strict: 'error',
    spec: `${SPEC} §1.5, §1.6`,
    explanation:
      'The specification restricts chromosome names to 1–255 letters, digits and underscores so that files are portable between tools. Real genomes break this rule all the time (`MT192765.1`, `HLA-A*01:01`, `NC_000001.11`), ' +
      'and tools accept such names, so this is only checked in the strict profile.',
    bad: [{ text: ex`
      NC_000001.11→1000→5000
    `, profile: 'strict' }],
  },
  chromNamingMixed: {
    code: 'BED021',
    title: 'Chromosome names mix the `chr1` and `1` styles',
    level: 'warning',
    spec: `${SPEC} §3.1`,
    explanation:
      'UCSC names chromosomes `chr1`, `chrX`, `chrM`; Ensembl and NCBI use `1`, `X`, `MT`. Tools compare names as plain text, so `chr1` and `1` are two different sequences and features on one of them are silently ignored in any comparison. ' +
      'A file that contains both styles is usually two files from different sources joined together.',
    bad: [ex`
      chr1→1000→5000
      1→7000→7250
    `],
  },
  positionInvalid: {
    code: 'BED022',
    title: 'chromStart or chromEnd is not a non-negative integer',
    level: 'error',
    spec: `${SPEC} §1.6`,
    explanation:
      'Start and end are whole numbers written with digits only: no sign, no decimal point, no thousands separators, no exponent. ' +
      'The best-known offender is scientific notation: R writes 100000 as `1e+05` unless told otherwise (`options(scipen = 999)`), and spreadsheets do the same to large numbers. ' +
      'Negative starts appear when a flank is subtracted near the beginning of a chromosome. Parsers reject such lines or, worse, read `1e+05` as 1.',
    bad: [
      { text: ex`
        chr1→1e+05→200000
      `, note: 'scientific notation written by R or a spreadsheet' },
      { text: ex`
        chr1→1,000→5,000
      `, note: 'thousands separators' },
      { text: ex`
        chr1→-50→450
      `, note: 'negative start' },
      { text: ex`
        chr1→1000.5→5000
      `, note: 'decimal' },
    ],
    good: [GOOD_BED3],
  },
  startAfterEnd: {
    code: 'BED023',
    title: 'chromStart is greater than chromEnd',
    level: 'error',
    spec: `${SPEC} §1.6`,
    explanation:
      'A feature runs from the smaller coordinate to the larger one, whatever its strand: the strand column says which way it points. Start may equal end (a zero-length feature such as an insertion point), but it may not exceed it. ' +
      'This happens when minus-strand features are written end first, or when 1-based coordinates are converted the wrong way round. BED counts from 0 and excludes the end: bases 1001 to 5000 in GFF or VCF numbering are written `1000 5000`.',
    bad: [ex`
      chr1→5000→1000
    `],
    good: [{ text: ex`
      chr1→1000→1000
    `, note: 'start equal to end is allowed: a zero-length feature' }],
  },
  coordinateTooLarge: {
    code: 'BED024',
    title: 'Coordinate does not fit in 32 bits',
    level: 'warning',
    spec: `${SPEC} §1.6`,
    explanation:
      'The specification allows coordinates up to 2^64−1 when the chromosome length is unknown, but a coordinate must never exceed the length of its chromosome, and only a handful of sequenced chromosomes are longer than 4,294,967,295 bases. ' +
      'Much software stores positions in 32-bit integers and overflows beyond that. A value this large is almost always an arithmetic overflow or a corrupted number.',
    bad: [ex`
      chr1→4294967196→4294967296
    `],
  },
  notSorted: {
    code: 'BED025',
    title: 'Features are not sorted',
    level: 'info',
    strict: 'warning',
    spec: `${SPEC} §3.4`,
    explanation:
      'Sorting is recommended, not required: all lines of one chromosome together, ordered by start. Indexing with tabix, conversion to bigBed and the `-sorted` modes of bedtools need it. ' +
      'Sort with `sort -k1,1 -k2,2n -k3,3n` or `bedtools sort`. Reported once per file.',
    bad: [ex`
      chr1→7000→7250
      chr1→1000→5000
    `],
  },

  // ---------------------------------------------------------------- name, score, strand
  nameWhitespace: {
    code: 'BED030',
    title: 'Name contains a space',
    level: 'warning',
    spec: `${SPEC} §1.7, §3.2`,
    explanation:
      'A space in the name is allowed only when the whole file is separated by single tabs, and even then the specification advises against it, because parsers that split on any whitespace (awk, the UCSC tools) see two fields and shift every later column. Replace the space with `_`.',
    bad: [ex`
      chr1→1000→5000→my gene
    `],
  },
  nameTooLong: {
    code: 'BED031',
    title: 'Name is longer than 255 characters',
    level: 'off',
    strict: 'error',
    spec: `${SPEC} §1.7`,
    explanation: 'The specification limits the name to 255 characters. Tools generally accept longer names, so this is only checked in the strict profile; very long names usually mean that a whole annotation string was put in the name column.',
    bad: [{ text: ex`
      chr1→1000→5000→${'ACGT'.repeat(64)}
    `, profile: 'strict' }],
  },
  nameExcelDate: {
    code: 'BED032',
    title: 'Name looks like a gene symbol converted to a date by a spreadsheet',
    level: 'warning',
    explanation:
      'Excel and other spreadsheets silently turn gene symbols into dates: MARCH1 becomes `1-Mar`, SEPT2 becomes `2-Sep`, DEC1 becomes `1-Dec`, and RIKEN identifiers such as 2310009E13 become `2.31E+13`. ' +
      'About a fifth of papers with supplementary gene lists were found to contain such errors (Ziemann, Eren and El-Osta, Genome Biology 2016). The original symbol cannot be recovered from the file: go back to the source and import the column as text. ' +
      'To keep false alarms low, only names that are *entirely* a day-month or month-year pair in the exact form spreadsheets write (`1-Mar`, `Sep-07`), or a three-digit mantissa with exponent (`2.31E+13`), are reported.',
    bad: [
      ex`
        chr1→1000→5000→1-Mar→0→+
      `,
      ex`
        chr2→1000→5000→Sep-07→0→-
      `,
    ],
    good: [{ text: ex`
      chr1→1000→5000→MARCHF1→0→+
      chr1→7000→7250→Mar-A-Lago→0→+
    `, note: 'longer names that merely contain a month are left alone' }],
  },
  scoreInvalid: {
    code: 'BED033',
    title: 'Score is not an integer from 0 to 1000',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC} §1.7`,
    explanation:
      'The score is a whole number between 0 and 1000 that the Genome Browser turns into a shade of grey. Many programs put a p-value, a fold change or a read count there instead. Tools that ignore the score do not mind, ' +
      'but anything that follows the definition (the UCSC utilities, for one) may reject the file or draw it wrongly. Rescale the value into 0–1000, or write `0` and keep the real number in an extra column after the standard ones.',
    bad: [
      ex`
        chr1→1000→5000→peak1→12.5→+
      `,
      ex`
        chr1→1000→5000→peak1→4821→+
      `,
    ],
  },
  scoreDot: {
    code: 'BED034',
    title: 'Score is `.` instead of a number',
    level: 'info',
    strict: 'error',
    spec: `${SPEC} §1.7`,
    explanation:
      'Many pipelines write `.` when there is no score. Tools that ignore the score accept that, but the specification asks for `0` when the score carries no information, and a parser that reads the score as a number fails on `.`.',
    bad: [ex`
      chr1→1000→5000→geneA→.→+
    `],
  },
  strandInvalid: {
    code: 'BED035',
    title: 'Strand is not `+`, `-` or `.`',
    level: 'error',
    spec: `${SPEC} §1.7`,
    explanation:
      'The strand is a single character: `+`, `-`, or `.` when it is unknown or does not apply. Words (`plus`, `forward`), numbers (`1`, `-1`) and the `*` used by Bioconductor are not understood: ' +
      'strand-aware operations then treat the feature as unstranded, drop it, or stop.',
    bad: [ex`
      chr1→1000→5000→geneA→0→+
      chr1→7000→7250→geneB→0→minus
    `],
  },

  // ---------------------------------------------------------------- thickStart, thickEnd, itemRgb
  thickInvalid: {
    code: 'BED036',
    title: 'thickStart or thickEnd is not a non-negative integer',
    level: 'error',
    spec: `${SPEC} §1.8`,
    explanation:
      'thickStart and thickEnd are positions on the chromosome, written like chromStart and chromEnd: digits only. They mark the part of the feature drawn thick (the coding region of a transcript). ' +
      'When there is no such part, repeat chromStart in both columns.',
    bad: [ex`
      chr1→1000→5000→geneA→0→+→1200→4800
      chr1→7000→7250→geneB→0→-→7e3→7250
    `],
  },
  thickMinusOne: {
    code: 'BED039',
    title: 'thickStart or thickEnd is -1',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC} §1.8`,
    explanation:
      'Some annotation files (the reference annotations of Rp-Bp are one example) carry `-1` in thickStart and thickEnd for transcripts without a coding region. Interval tools that ignore these columns read the file, ' +
      'but the specification defines both as non-negative positions, so a tool that validates them may refuse it. The portable way to say "no thick part" is chromStart in both columns.',
    bad: [ex`
      chr20→87249→97094→ENST00000382410→0→+→87709→96414
      chr20→87671→97094→ENST00000608838→0→+→-1→-1
    `],
    good: [ex`
      chr20→87249→97094→ENST00000382410→0→+→87709→96414
      chr20→87671→97094→ENST00000608838→0→+→87671→87671
    `],
  },
  thickOutOfRange: {
    code: 'BED037',
    title: 'thickStart or thickEnd lies outside the feature',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC} §1.8`,
    explanation:
      'The thick part must lie inside the feature: chromStart ≤ thickStart ≤ thickEnd ≤ chromEnd. Positions are absolute chromosome coordinates, not offsets from the start. ' +
      'Genome browsers draw such features wrongly and validating converters reject them. When there is no thick part, set both to chromStart.',
    bad: [ex`
      chr1→1000→5000→geneA→0→+→1200→4800
      chr1→7000→7250→geneB→0→-→6900→7250
    `],
  },
  itemRgb: {
    code: 'BED038',
    title: 'itemRgb is not `0` or three numbers from 0 to 255',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC} §1.8`,
    explanation:
      'The colour is written as red, green and blue values from 0 to 255 separated by commas, without spaces: `255,0,0`. A single `0` means black; no other single number, colour name or hexadecimal code is valid. ' +
      'Tools that do not draw anything ignore the column, but genome browsers reject the line or fall back to black.',
    bad: [ex`
      chr1→1000→5000→geneA→0→+→1000→5000→255,0,0
      chr1→7000→7250→geneB→0→-→7000→7250→#FF0000
    `],
  },

  // ---------------------------------------------------------------- blocks
  blockCount: {
    code: 'BED040',
    title: 'blockCount is not a positive integer',
    level: 'error',
    spec: `${SPEC} §1.9`,
    explanation:
      'blockCount is the number of blocks (exons) and must be at least 1: a feature without sub-structure has one block covering all of it (`1`, its length, `0`). ' +
      'The field table of the specification gives the range as starting at 0, but its text says "greater than 0", and a feature with no blocks cannot satisfy the rule that blocks start at chromStart and end at chromEnd.',
    bad: [ex`
      chr22→1000→5000→cloneA→960→+→1000→5000→0→0→567,488→0,3512
    `],
  },
  blockListMalformed: {
    code: 'BED041',
    title: 'blockSizes or blockStarts is not a comma-separated list of integers',
    level: 'error',
    spec: `${SPEC} §1.9`,
    explanation:
      'Both lists are non-negative whole numbers separated by commas, with no spaces; one comma after the last number is allowed. A negative size, a different separator, or a missing comma between two numbers makes the list unreadable.',
    bad: [ex`
      chr22→1000→5000→cloneA→960→+→1000→5000→0→2→567;488→0,3512
    `],
  },
  blockListCount: {
    code: 'BED042',
    title: 'Number of block sizes or starts differs from blockCount',
    level: 'error',
    spec: `${SPEC} §1.9`,
    explanation:
      'blockSizes and blockStarts must each list exactly blockCount values. A mismatch means a list was truncated (long lists are a common victim of spreadsheet cell limits) or blockCount was not updated after editing. Parsers stop with an error, or read beyond the list.',
    bad: [ex`
      chr22→1000→5000→cloneA→960→+→1000→5000→0→3→567,488→0,3512
    `],
  },
  blockFirstStart: {
    code: 'BED043',
    title: 'First block does not start at chromStart',
    level: 'error',
    spec: `${SPEC} §1.9`,
    explanation:
      'Block starts are offsets from chromStart, and the first block must begin exactly at chromStart, so the first value of blockStarts is always `0`. ' +
      'A first value equal to chromStart itself means absolute coordinates were written instead of offsets.',
    bad: [ex`
      chr22→1000→5000→cloneA→960→+→1000→5000→0→2→567,488→1000,4512
    `],
  },
  blockLastEnd: {
    code: 'BED044',
    title: 'Last block does not end at chromEnd',
    level: 'error',
    spec: `${SPEC} §1.9`,
    explanation:
      'The blocks must span the whole feature: the last block start plus the last block size must equal chromEnd − chromStart. If it does not, either chromEnd or the block lists were changed without the other, ' +
      'for example by trimming or extending the feature. Validating converters reject such lines, and anything that extracts the blocks (spliced sequence, exon coverage) works on the wrong bases.',
    bad: [ex`
      chr22→1000→5000→cloneA→960→+→1000→5000→0→2→567,400→0,3512
    `],
  },
  blockOverlap: {
    code: 'BED045',
    title: 'Blocks overlap or are not in ascending order',
    level: 'error',
    spec: `${SPEC} §1.9`,
    explanation:
      'Blocks are listed from left to right along the chromosome, on both strands, and may touch but not overlap. For minus-strand transcripts the exons must still be written in ascending coordinate order, not in transcript order.',
    bad: [ex`
      chr22→1000→5000→cloneA→960→-→1000→5000→0→2→1488,567→3512,0
    `],
  },
  blockOutsideFeature: {
    code: 'BED046',
    title: 'Block extends beyond chromEnd',
    level: 'error',
    spec: `${SPEC} §1.9`,
    explanation:
      'Every block must lie inside the feature: chromStart + blockStart + blockSize may not exceed chromEnd. A block that sticks out usually means the starts are absolute coordinates rather than offsets from chromStart, or chromEnd was shortened without updating the blocks.',
    bad: [ex`
      chr22→1000→5000→cloneA→960→+→1000→5000→0→2→567,888→0,3512
    `],
  },
});
