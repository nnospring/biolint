import { defineRules, ex } from '../../core/rules.ts';

// FASTA has no formal standard. The rules below rest on three written sources, cited in each rule's `spec`:
//   - NCBI BLAST help, "Query input and database selection: FASTA" (the defline, the residue codes, no blank lines);
//   - the IUPAC-IUB nucleotide (NC-IUB 1984) and amino-acid (JCBN 1983, 3AA-21) one-letter codes;
//   - faidx(5) and the htslib index builder behind `samtools faidx` (even line lengths, no blank line in a record).

const GOOD_DNA = ex`
  >chr1 Homo sapiens test contig
  ACGTACGTACGTNNNNacgtacgt
  ACGTACGTACGTACGTACGTACGT
  ACGTAC
  >chr2
  GGGCCCTTTAAA
`;

const GOOD_PROTEIN = ex`
  >sp|P01013|OVAX_CHICK Ovalbumin-related protein X
  QIKDLLVSSSTDLDTTLVLVNAIYFKGMWKTAFNAEDTREMPFHVTKQESKPVQMMCMNN
  SFNVATLPAEKMKILELPFASGDLSMLVLLPDEVSDLERIEKTINFEKLTEWTNPNTMEK
  RRVKVYLPQMKIEEKYNLTSVLMALGMTDLFIPSANLTGISSAESLKISQAVHGAF*
`;

export const GOOD_FASTA_EXAMPLES = [GOOD_DNA, GOOD_PROTEIN];

export const F = defineRules('fasta', {
  // ---------------------------------------------------------------- structure
  dataBeforeHeader: {
    code: 'FA001',
    title: 'Sequence data before the first > header',
    level: 'error',
    spec: 'NCBI BLAST help, FASTA; faidx(5)',
    explanation:
      'A FASTA file is a series of records, each starting with a description line that begins with `>`. Text before the first `>` belongs to no record: ' +
      '`samtools faidx` stops with "Format error, unexpected ...", and parsers that are more forgiving silently drop the lines. ' +
      'The usual causes are a header that lost its `>`, a file in another format (FASTQ, GenBank, Clustal) saved with a FASTA name, or the output of `grep -v ">"`.',
    bad: [
      { text: ex`
        ACGTACGTACGT
        >seq2
        ACGTACGTAAAA
      `, note: 'the first record has no header line' },
    ],
    good: [GOOD_DNA],
  },
  headerEmpty: {
    code: 'FA002',
    title: 'Header has no sequence identifier',
    level: 'error',
    spec: 'NCBI BLAST help, FASTA; faidx(5)',
    explanation:
      'The `>` must be followed by an identifier: the word up to the first space is how every tool names the sequence (the first column of a `.fai` index, the `@SQ SN` of an alignment, the subject of a BLAST hit). ' +
      'A bare `>` gives the record an empty name, so it cannot be fetched and clashes with every other unnamed record.',
    bad: [ex`
      >
      ACGTACGT
    `],
  },
  headerLeadingWhitespace: {
    code: 'FA003',
    title: 'Whitespace between > and the identifier',
    level: 'warning',
    spec: 'faidx(5)',
    explanation:
      'Tools disagree about `> name`. `samtools faidx` skips the space and calls the sequence `name`; parsers that take "everything up to the first space" get an empty identifier, ' +
      'so the same file yields different sequence names in different programs. Remove the space.',
    bad: [ex`
      > seq1 sample A
      ACGTACGT
    `],
    good: [ex`
      >seq1 sample A
      ACGTACGT
    `],
  },
  sequenceEmpty: {
    code: 'FA004',
    title: 'Record has no sequence',
    level: 'warning',
    strict: 'error',
    spec: 'NCBI BLAST help, FASTA; faidx(5)',
    explanation:
      'A header is followed directly by the next header or by the end of the file. `samtools faidx` leaves such a record out of the index without a message, or fails with "File truncated" when it is the last record, ' +
      'and many other tools reject or skip zero-length sequences. It usually means an upstream step produced nothing for this entry, or a header line was duplicated.',
    bad: [ex`
      >seq1
      >seq2
      ACGTACGT
    `],
  },
  blankLineInSequence: {
    code: 'FA005',
    title: 'Blank line inside a sequence',
    level: 'error',
    spec: 'NCBI BLAST help, FASTA ("Blank lines are not allowed in the middle of FASTA input"); faidx(5)',
    explanation:
      'An empty line sits between two sequence lines of the same record. `samtools faidx` cannot index the file, and several parsers treat the blank line as the end of the record and discard the rest of the sequence. ' +
      'Delete the blank line; if the lines after it belong to a new record, its `>` header is missing.',
    bad: [ex`
      >seq1
      ACGTACGT

      ACGTACGT
    `],
  },
  blankLineBetweenRecords: {
    code: 'FA006',
    title: 'Blank line between records',
    level: 'info',
    strict: 'warning',
    spec: 'NCBI BLAST help, FASTA ("Blank lines are not allowed in the middle of FASTA input")',
    explanation:
      'There is an empty line before a `>` header. `samtools faidx` and most parsers skip it, so the file works; NCBI\'s description of the format does not allow it, and simple line-counting scripts miscount records. ' +
      'Remove the blank lines with `sed -i \'/^$/d\' file.fa`.',
    bad: [ex`
      >seq1
      ACGTACGT

      >seq2
      ACGTACGT
    `],
  },
  lineLengthUneven: {
    code: 'FA007',
    title: 'Sequence lines of a record have different lengths',
    level: 'warning',
    spec: 'faidx(5)',
    explanation:
      'Within one record every sequence line must have the same length, except the last, which may be shorter. Random access relies on this: `samtools faidx` refuses the file with "Different line length in sequence", ' +
      'and so does every tool that builds a `.fai` index through htslib. It happens after editing a sequence by hand or joining pieces with `cat`. Re-wrap with `seqkit seq -w 60 in.fa > out.fa`.',
    bad: [ex`
      >chr1
      ACGTACGTACGT
      ACGTACG
      ACGTACGTACGT
    `],
    good: [ex`
      >chr1
      ACGTACGTACGT
      ACGTACGTACGT
      ACGTACG
    `],
  },
  duplicateId: {
    code: 'FA008',
    title: 'Sequence identifier is used more than once',
    level: 'warning',
    strict: 'error',
    spec: 'faidx(5)',
    explanation:
      'Two records have the same identifier (the header text up to the first whitespace; the description after it does not count). `samtools faidx` warns "Ignoring duplicate sequence" and indexes only the first, ' +
      'so the second can never be retrieved, and tools that need unique names (such as `makeblastdb -parse_seqids`) stop. Duplicates come from concatenating files, or from identifiers that differ only after the first space.',
    bad: [ex`
      >seq1 first copy
      ACGTACGT
      >seq1 second copy
      TTTTACGT
    `],
  },
  commentLine: {
    code: 'FA009',
    title: 'Comment line in a FASTA file',
    level: 'error',
    spec: 'NCBI BLAST help, FASTA; faidx(5)',
    explanation:
      'A line starts with `;` or `#`. The original FASTA programs accepted `;` comment lines and a few libraries tolerate `#`, but current tools do not: before the first header `samtools faidx` fails, ' +
      'and inside a record the comment text is read as sequence. Delete the comment lines or move the text into the description after `>id`.',
    bad: [ex`
      >seq1
      ACGTACGT
      # trimmed with my_script v2
      >seq2
      ACGTACGT
    `],
  },

  // ---------------------------------------------------------------- sequence content
  sequenceWhitespace: {
    code: 'FA010',
    title: 'Whitespace inside a sequence line',
    level: 'error',
    spec: 'NCBI BLAST help, FASTA; faidx(5)',
    explanation:
      'A sequence line contains spaces or tabs. An index made by `samtools faidx` counts only the visible characters but seeks by byte, so regions fetched from such a file are shifted; ' +
      'other tools count the spaces as residues or stop. Sequences copied from a web page or a document often come in blocks of ten separated by spaces. Remove them: `sed -i \'/^>/! s/[ \\t]//g\' file.fa`.',
    bad: [
      { text: ex`
        >seq1
        ACGTACGTAC GTACGTACGT ACGTACGTAC
      `, note: 'blocks of ten separated by spaces' },
    ],
  },
  sequenceDigits: {
    code: 'FA011',
    title: 'Digits inside a sequence',
    level: 'error',
    spec: 'NCBI BLAST help, FASTA ("any numerical digits in the query sequence should either be removed or replaced")',
    explanation:
      'Digits are not residue codes. They are almost always the position numbers of a GenBank, EMBL or web-page listing that was pasted as is. Indexers count them as bases, which shifts every coordinate after them. ' +
      'Strip the numbers and spaces: `sed -i \'/^>/! s/[0-9 \\t]//g\' file.fa`.',
    bad: [
      { text: ex`
        >U49845.1 pasted from the GenBank ORIGIN block
                1 gatcctccat atacaacggt atctccacct caggtttaga tctcaacaac ggaaccattg
               61 ccgacatgag acagttaggt atcgtcgaga gttacaagct aaaacgagca gtagtcagct
      `, note: 'position numbers and spaces from a GenBank flat file' },
      ex`
        >seq1
        ACGTACGT10ACGT
      `,
    ],
  },
  headerMarkerInSequence: {
    code: 'FA012',
    title: '> in the middle of a sequence line',
    level: 'error',
    spec: 'NCBI BLAST help, FASTA',
    explanation:
      'A `>` only starts a record at the beginning of a line. In the middle of a sequence line it means the newline before the next header is missing, typically because the previous file did not end with a newline when files were joined with `cat`. ' +
      'The next record is then swallowed into this one, header text and all.',
    bad: [ex`
      >seq1
      ACGTACGTACGT>seq2
      ACGTACGTAAAA
    `],
  },
  invalidResidue: {
    code: 'FA013',
    title: 'Letter is not a valid residue code for this kind of sequence',
    level: 'error',
    spec: 'IUPAC-IUB (NC-IUB 1984) nucleotide codes, as listed in NCBI BLAST help',
    explanation:
      'A nucleotide sequence may contain `A C G T U`, `N` and the ambiguity codes `R Y K M S W B D H V` (upper or lower case); `X` is tolerated because some maskers write it. ' +
      'Other letters are not bases, and tools that expect nucleotides replace them with `N` or a random base without saying so. They are typing or OCR errors, or protein sequence in a nucleotide file. ' +
      'biolint decides per file whether it holds nucleotides or protein and only reports letters when that is clear; say so explicitly with `-o fasta.alphabet=dna` (or `rna`, `protein`) if it guessed wrong.',
    bad: [
      { text: ex`
        >seq1
        ACGTACGTACGTACGTACGTACGTACGTACGTAEGTACGTACGTACGT
      `, note: '`E` in a DNA sequence' },
    ],
  },
  nonResidueCharacter: {
    code: 'FA014',
    title: 'Character is not a residue code',
    level: 'warning',
    strict: 'error',
    spec: 'NCBI BLAST help, FASTA',
    explanation:
      'Besides letters, a sequence may contain `-` (a gap in an alignment) and `*` (a translation stop). Other punctuation is not part of FASTA: `.` and `~` are gap symbols of other alignment formats, `?` marks missing data in phylogenetics formats, ' +
      'and `&` joins two strands in ViennaRNA input. Some tools pass these characters through, others turn them into `N`/`X` or stop, so the result depends on the program.',
    bad: [
      { text: ex`
        >aln1
        ACGT..ACGTACGT
      `, note: '`.` used as a gap symbol' },
    ],
    good: [
      { text: ex`
        >aln1
        ACGT--ACGTACGT
        >aln2
        ACGTTTACGT--GT
      `, note: '`-` gaps are fine' },
    ],
  },
  mixedUracilThymine: {
    code: 'FA015',
    title: 'Sequence contains both T and U',
    level: 'warning',
    spec: 'IUPAC-IUB (NC-IUB 1984) nucleotide codes',
    explanation:
      'A nucleotide sequence is written either as DNA (with `T`) or as RNA (with `U`). Both in one record usually means an RNA sequence was only partly converted, or two sources were pasted together. ' +
      'Tools that expect DNA do not all read `U` as `T`; where they do not, every `U` becomes a mismatch or an `N`. Convert with `seqkit seq --rna2dna` (or `--dna2rna`).',
    bad: [ex`
      >mir21 partly converted
      UAGCUUAUCAGACTGATGTTGACTGUUGAAUCUCAUGG
    `],
  },
  alphabetSwitch: {
    code: 'FA016',
    title: 'File switches from nucleotide to protein sequences',
    level: 'warning',
    spec: 'NCBI BLAST help, FASTA',
    explanation:
      'The file started with nucleotide sequences, and from this record on the lines look like protein (many letters that are not nucleotide codes). ' +
      'Databases and indexes are built for one kind of sequence (`makeblastdb -dbtype nucl` or `prot`), so a mixed file is mis-handled. If the mix is intended, split the file; biolint stops checking letters against the nucleotide codes from here.',
    // The example needs enough nucleotide sequence for the file to be classified with confidence first.
    bad: [{
      text: '>contig1\n' + 'ACGTTGCAAGCTTGCATGCCTGCAGGTCGACTCTAGAGGATCCCCGGGTACCGAGCTCGA\n'.repeat(70) + '>prot1 pasted into the same file\nMKVLAAGIVGLLLAQWPSEFQDIRHMNY\n',
      note: 'a protein record after 4 kb of DNA',
    }],
  },
});

/**
 * Rules that no small, self-contained example can trigger, so they are not part of `fasta.rules`
 * (every listed rule must prove itself with an example). They are reported like any other rule.
 */
export const F_UNLISTED = defineRules('fasta', {
  idTrackingCapped: {
    code: 'FA017',
    title: 'Too many sequences to check all identifiers for duplicates',
    level: 'info',
    bad: [{ text: '>seq1\nACGT\n>seq2\nACGT\n>seq3\nACGT\n', options: { maxIds: 2 }, note: 'the cap lowered to two identifiers to show the message' }],
    explanation:
      'Finding duplicate identifiers means remembering every identifier seen. To keep memory bounded biolint stops remembering after a fixed number of records (one million by default, `-o fasta.maxIds=N` to change); ' +
      'later records are still compared with the remembered ones, but two late records that share an identifier are not detected. For a complete check use `seqkit rmdup -D dup.txt file.fa > /dev/null`, or `grep "^>" file.fa | cut -d" " -f1 | sort | uniq -d`.',
  },
});
