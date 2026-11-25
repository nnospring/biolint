import { defineRules, ex } from '../../core/rules.ts';

// FASTQ is defined by Cock et al., "The Sanger FASTQ file format for sequences with quality scores, and the
// Solexa/Illumina FASTQ variants", Nucleic Acids Research 38:1767-1771 (2010). The paper has no section numbers,
// so rules cite its section headings ("FASTQ definition", Table 1, ...).
const COCK = 'Cock et al. 2010 (NAR 38:1767)';

const GOOD_FOUR_LINE = ex`
  @SRR001666.1 071112_SLXA-EAS1_s_7:5:1:817:345 length=36
  GGGTGATGGCCGCTGCCGATGGCGTCAAATCCCACC
  +
  IIIIIIIIIIIIIIIIIIIIIIIIIIIIII9IG9IC
  @SRR001666.2 071112_SLXA-EAS1_s_7:5:1:801:338 length=36
  GTTCAGGGATACGACGTTTGTATTTTAAGAATCTGA
  +SRR001666.2 071112_SLXA-EAS1_s_7:5:1:801:338 length=36
  IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII6IBI
`;

export const GOOD_FASTQ_EXAMPLES = [GOOD_FOUR_LINE];

export const Q = defineRules('fastq', {
  // ---------------------------------------------------------------- record structure
  titleMissingAt: {
    code: 'FQ001',
    title: 'Record does not start with @',
    level: 'error',
    spec: `${COCK}, "FASTQ definition"`,
    explanation:
      'Every FASTQ record begins with a title line whose first character is `@`. Here a record was expected and the line starts with something else, so the four-line rhythm of the file is broken: ' +
      'a line was lost or added (often by an interrupted copy or a careless `head`/`split`), or the file is not FASTQ at all. Tools either stop here or read every following record wrongly. ' +
      'biolint reports the first such line and resumes at the next line that starts with `@`.',
    bad: [
      { text: ex`
        @read1
        ACGTACGT
        +
        IIIIIIII
        ACGTACGT
        +
        IIIIIIII
      `, note: 'the title line of the second record is missing' },
    ],
    good: [GOOD_FOUR_LINE],
  },
  plusLineMissing: {
    code: 'FQ002',
    title: 'The + separator line is missing',
    level: 'error',
    spec: `${COCK}, "FASTQ definition"`,
    explanation:
      'After the sequence comes a line starting with `+`, which separates the bases from their qualities. Without it a parser cannot tell where the sequence ends; ' +
      'it either stops or reads the quality string as more sequence. The line is usually lost when a file is truncated or edited by hand.',
    bad: [ex`
      @read1
      ACGTACGT
      IIIIIII!
      @read2
      ACGTACGT
      +
      IIIIIIII
    `],
  },
  plusLineMismatch: {
    code: 'FQ003',
    title: 'Text after + differs from the title',
    level: 'warning',
    strict: 'error',
    spec: `${COCK}, "FASTQ definition"`,
    explanation:
      'The `+` line may be bare, or it may repeat the title line exactly. Text that is different points to records that were shuffled or spliced together: the sequence and the qualities may belong to different reads. ' +
      'Most tools ignore the text after `+`, so the file still parses; `seqtk seq in.fq > out.fq` rewrites it with bare `+` lines.',
    bad: [ex`
      @read1
      ACGTACGT
      +read2
      IIIIIIII
    `],
  },
  lengthMismatch: {
    code: 'FQ004',
    title: 'Sequence and quality have different lengths',
    level: 'error',
    spec: `${COCK}, "FASTQ definition"`,
    explanation:
      'There must be exactly one quality character per base. A different count means the record is damaged: a line was cut short (truncated transfer, full disk), bases were trimmed without trimming the qualities, ' +
      'or two writers interleaved their output in one file. Aligners and trimmers stop on such a record.',
    bad: [
      { text: ex`
        @read1
        ACGTACGT
        +
        IIIIIIIIII
      `, note: 'ten quality characters for eight bases' },
      { text: ex`
        @read1 lane 1
        ACGTACGTAC
        +
        IIIIIIII
        @read2 lane 1
        ACGTACGT
        +
        IIIIIIII
      `, note: 'the quality of the first read is two characters short' },
    ],
  },
  qualityInvalidCharacter: {
    code: 'FQ005',
    title: 'Quality character outside the printable range',
    level: 'error',
    spec: `${COCK}, Table 1`,
    explanation:
      'Quality scores are stored as single printable ASCII characters, `!` (33) to `~` (126). A byte outside that range cannot be a score in any FASTQ variant: the file is damaged, was written in the wrong encoding, ' +
      'or is not text. (Spaces and tabs are reported as FQ011; other control characters by the generic rule TXT007.)',
    bad: [
      { text: '@read1\nACGTACGTA\n+\nIIIIéIII\n', note: 'a non-ASCII character in the quality string' },
    ],
  },
  sequenceInvalidCharacter: {
    code: 'FQ006',
    title: 'Sequence character is not a nucleotide code',
    level: 'warning',
    spec: `${COCK}, "FASTQ definition"`,
    explanation:
      'The format sets no hard limit on sequence characters but recommends the IUPAC nucleotide codes (`A C G T U N` and the ambiguity codes `R Y K M S W B D H V`), in upper or lower case, plus `-` for a gap. ' +
      'Anything else is passed through by some tools and turned into `N` or rejected by others. A `.` is the "no call" of early Illumina pipelines (write `N`); digits after a leading base are SOLiD colour space, which is a different format.',
    bad: [
      { text: ex`
        @read1
        ACGT.CGT
        +
        IIIIIIII
      `, note: '`.` for an uncalled base' },
    ],
  },
  truncatedRecord: {
    code: 'FQ007',
    title: 'Record is incomplete',
    level: 'error',
    spec: `${COCK}, "FASTQ definition"`,
    explanation:
      'A record needs four parts: title, sequence, `+` line and quality. Here the file ends, or the next record begins, before all four were seen. ' +
      'At the end of a file this is the signature of truncation: an interrupted download or copy, a job killed while writing, or `head -n` with a count that is not a multiple of four. Regenerate or re-transfer the file and compare checksums.',
    bad: [
      { text: ex`
        @read1
        ACGTACGT
        +
        IIIIIIII
        @read2
        ACGTACGT
      `, note: 'the file ends after the sequence of the last record' },
    ],
  },
  multiLineRecord: {
    code: 'FQ008',
    title: 'Sequence and quality are wrapped over several lines',
    level: 'warning',
    spec: `${COCK}, "FASTQ definition"`,
    explanation:
      'The format allows the sequence and the quality string to be line-wrapped, but the authors recommend against it and nearly every current tool assumes exactly four lines per record. ' +
      'Because `@` and `+` are also valid quality characters, a wrapped file cannot be parsed line by line; four-line parsers read garbage or stop. Unwrap it with `seqtk seq -l0 in.fq > out.fq`.',
    bad: [ex`
      @read1
      ACGTACGTAC
      GTACGTAC
      +
      IIIIIIIIII
      IIIIIIII
    `],
  },
  legacyQualityEncoding: {
    code: 'FQ009',
    title: 'Quality scores use a legacy +64 encoding',
    level: 'warning',
    spec: `${COCK}, Table 1`,
    explanation:
      'The quality characters start at `;` or `@` and reach beyond `J`, which is the pattern of the Solexa and Illumina 1.3-1.7 variants (ASCII offset 64) rather than the standard Sanger encoding (offset 33) that every current tool expects. ' +
      'Read as offset 33, the scores are inflated by 31, so quality trimming and variant calling are silently wrong. Convert once, early in the pipeline. ' +
      'The variants cannot be told apart with certainty: biolint only reports when no character is below `;` and some are above `J`, and treats files of one constant quality character as standard.',
    // Illumina 1.5-style qualities: `B` is the lowest character, `h` (Q40) the highest.
    bad: [ex`
      @HWUSI-EAS100R:6:73:941:1973#0/1
      GATTTGGGGTTCAAAGCAGTATCGATCAAATAGTAAATCC
      +
      hhhhhhhhhhhghhhhhhhehhhedhhhhfhhhhhdggBB
    `],
    good: [GOOD_FOUR_LINE],
  },
  emptyRead: {
    code: 'FQ010',
    title: 'Read has no bases',
    level: 'warning',
    spec: `${COCK}, "FASTQ definition"`,
    explanation:
      'The sequence and quality lines are empty. The format permits a zero-length read, and adapter trimmers produce them when a read is all adapter, but some aligners and assemblers stop on one. ' +
      'Drop them when trimming (`cutadapt -m 1`, `fastp -l 1`) and keep paired files in step (`cutadapt` and `fastp` do this when given both files).',
    bad: [
      { text: '@read1\n\n+\n\n@read2\nACGT\n+\nIIII\n', note: 'the first read is empty' },
    ],
  },
  whitespaceInRecord: {
    code: 'FQ011',
    title: 'Whitespace in a sequence or quality line',
    level: 'error',
    spec: `${COCK}, "FASTQ definition" ("White space such as tabs or spaces is not permitted")`,
    explanation:
      'Spaces and tabs are not allowed in the sequence, and are not quality characters (the quality range starts at `!`, one above the space). ' +
      'They appear when a table was converted to FASTQ incompletely or a line picked up trailing spaces in an editor; parsers then count them as bases or scores, or stop.',
    bad: [
      { text: ex`
        @read1
        ACGT ACGT
        +
        IIIIIIIII
      `, note: 'a space inside the sequence' },
    ],
  },
  blankLine: {
    code: 'FQ012',
    title: 'Blank line between records',
    level: 'error',
    spec: `${COCK}, "FASTQ definition"`,
    explanation:
      'An empty line appears where a title line was expected, with more records after it. The format has no blank lines between records, and strict four-line parsers stop there, ' +
      'while kseq-based readers (bwa, minimap2, seqtk) skip ahead to the next `@`. Remove the empty lines, taking care not to delete the empty sequence and quality lines of zero-length reads.',
    bad: [ex`
      @read1
      ACGTACGT
      +
      IIIIIIII

      @read2
      ACGTACGT
      +
      IIIIIIII
    `],
  },

  // ---------------------------------------------------------------- pairing
  pairCountMismatch: {
    code: 'FQ020',
    title: 'Paired reads are not complete pairs',
    level: 'error',
    spec: `${COCK}, "FASTQ definition" (paired reads as two matched files)`,
    explanation:
      'Paired-end data must contain both mates of every fragment, in the same order: either as two files with equal numbers of reads, or interleaved in one file as mate 1, mate 2, mate 1, ... ' +
      'Here the counts do not match (with `--paired`, the two files have different numbers of reads; in an interleaved file, the last read has no mate). ' +
      'One file was truncated, or the mates were filtered separately. Aligners stop ("paired reads have different names", "fewer reads in file") or, worse, pair the wrong reads. ' +
      'Re-pair with `seqkit pair -1 R1.fq -2 R2.fq` or BBMap `repair.sh`.',
    bad: [
      { text: ex`
        @frag1/1
        ACGTACGT
        +
        IIIIIIII
        @frag1/2
        TTGCATGC
        +
        IIIIIIII
        @frag2/1
        ACGTTTGT
        +
        IIIIIIII
      `, note: 'an interleaved file whose last read has no mate' },
    ],
  },
  pairNameMismatch: {
    code: 'FQ021',
    title: 'Mates of a pair have different read names',
    level: 'error',
    spec: `${COCK}, "FASTQ definition" (paired reads as two matched files)`,
    explanation:
      'The two mates of a fragment carry the same read name (apart from a trailing `/1` or `/2`, or the comment after the first space). ' +
      'Names that differ at the same position mean the files are out of step: one was sorted, filtered or trimmed without the other, or a read was lost. Everything after that point is paired with the wrong mate. ' +
      'With `--paired`, biolint compares a running digest of the names and reports the block of 4,096 reads in which the two files first differ. Re-pair with `seqkit pair -1 R1.fq -2 R2.fq` or BBMap `repair.sh`.',
    bad: [
      { text: ex`
        @frag1/1
        ACGTACGT
        +
        IIIIIIII
        @frag1/2
        TTGCATGC
        +
        IIIIIIII
        @frag2/1
        ACGTTTGT
        +
        IIIIIIII
        @frag3/2
        GGGTTTGT
        +
        IIIIIIII
      `, note: 'an interleaved file in which the fourth read is not the mate of the third' },
    ],
  },
});
