import { defineRules, ex } from '../../core/rules.ts';

// Section names refer to "GTF2.2: A Gene Annotation Format" (Brent lab, Washington University in St. Louis,
// mblab.wustl.edu/GTF22.html). Where Ensembl and GENCODE files differ from that definition, the default profile
// follows the files and the strict profile follows the definition; each rule says which is which.
const SPEC = 'GTF 2.2';

/** GTF 2.2 to the letter: only the nine defined feature types, both mandatory attributes first. */
const GOOD_GTF22 = ex`
  chr2→example→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1";
  chr2→example→CDS→1299→1350→.→+→0→gene_id "g1"; transcript_id "g1.t1";
  chr2→example→start_codon→1299→1301→.→+→0→gene_id "g1"; transcript_id "g1.t1";
  chr2→example→exon→1500→1618→.→+→.→gene_id "g1"; transcript_id "g1.t1";
  chr2→example→CDS→1500→1618→.→+→2→gene_id "g1"; transcript_id "g1.t1";
  chr2→example→exon→1800→2100→.→+→.→gene_id "g1"; transcript_id "g1.t1";
  chr2→example→CDS→1800→1898→.→+→0→gene_id "g1"; transcript_id "g1.t1";
  chr2→example→stop_codon→1899→1901→.→+→0→gene_id "g1"; transcript_id "g1.t1";
`;

/** The Ensembl/GENCODE dialect: gene and transcript lines, UTR features, numeric values without quotes. */
const GOOD_ENSEMBL = ex`
  #!genome-build GRCh38.p14
  1→havana→gene→1000→9000→.→-→.→gene_id "ENSG01"; gene_version "2"; gene_name "ABC1"; gene_biotype "protein_coding";
  1→havana→transcript→1000→9000→.→-→.→gene_id "ENSG01"; gene_version "2"; transcript_id "ENST01"; gene_name "ABC1"; tag "basic"; tag "CCDS";
  1→havana→exon→8000→9000→.→-→.→gene_id "ENSG01"; gene_version "2"; transcript_id "ENST01"; exon_number 1; gene_name "ABC1";
  1→havana→CDS→8000→8600→.→-→0→gene_id "ENSG01"; gene_version "2"; transcript_id "ENST01"; exon_number 1; gene_name "ABC1";
  1→havana→start_codon→8598→8600→.→-→0→gene_id "ENSG01"; gene_version "2"; transcript_id "ENST01"; exon_number 1; gene_name "ABC1";
  1→havana→five_prime_utr→8601→9000→.→-→.→gene_id "ENSG01"; gene_version "2"; transcript_id "ENST01"; gene_name "ABC1";
  1→havana→exon→1000→2000→.→-→.→gene_id "ENSG01"; gene_version "2"; transcript_id "ENST01"; exon_number 2; gene_name "ABC1";
`;

/** Valid in the default profile. */
export const GOOD_GTF_EXAMPLES = [GOOD_GTF22, GOOD_ENSEMBL];
/** Valid in both profiles. */
export const STRICT_GTF_EXAMPLES = [GOOD_GTF22];

export const R = defineRules('gtf', {
  // ---------------------------------------------------------------- columns
  columnCount: {
    code: 'GTF001',
    title: 'Feature line does not have nine tab-separated columns',
    level: 'error',
    spec: `${SPEC}, Introduction`,
    explanation:
      'Every feature line has nine columns separated by single tab characters: seqname, source, feature, start, end, score, strand, frame, attributes. The attributes in column 9 are separated from each other by spaces, so parsers split the line on tabs only. ' +
      'The usual cause is an editor or a copy-paste that turned the tabs into spaces.',
    bad: [
      { text: ex`
        chr1 example exon 150 200 . + . gene_id "g1"; transcript_id "g1.t1";
      `, note: 'separated by spaces' },
      { text: ex`
        chr1→example→exon→1200→1350→.→+→.
      `, note: 'no attributes column' },
    ],
    good: [GOOD_GTF22],
  },
  trailingTab: {
    code: 'GTF002',
    title: 'Line ends with an extra tab',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Introduction`,
    explanation: 'A tab after the attributes creates an empty tenth column. Most parsers ignore it; those that count columns reject the line. Scripts that append a tab to every field produce it.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1";→
    `],
  },
  emptyField: {
    code: 'GTF003',
    title: 'Empty column',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, GTF Field Definitions`,
    explanation: 'A column may not be left empty: a score or frame that does not apply is written as a single `.`. Empty columns appear when a script joins fields that contain missing values, and parsers that split on runs of whitespace then read a shifted line.',
    bad: [ex`
      chr1→→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1";
    `],
  },
  coordinateInvalid: {
    code: 'GTF004',
    title: 'Start or end is not a positive integer',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: <start> <end>`,
    explanation: 'Start and end are whole numbers counted from 1, and both ends are included. A 0 usually comes from BED, which counts starts from 0; `1e+05` and `1,000` are spreadsheet artefacts. Parsers stop at such a value or read it as something else.',
    bad: [
      { text: ex`
        chr1→example→exon→0→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1";
      `, note: 'a 0-based start' },
      ex`
        chr1→example→exon→1200→1.35e+03→.→+→.→gene_id "g1"; transcript_id "g1.t1";
      `,
    ],
  },
  startAfterEnd: {
    code: 'GTF005',
    title: 'Start is greater than end',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: <start> <end>`,
    explanation: 'Start must be less than or equal to end, also on the minus strand: the strand column gives the direction, not the order of the coordinates. Tools that compute feature lengths get negative numbers from such a line, or skip it.',
    bad: [ex`
      chr1→example→exon→1350→1200→.→-→.→gene_id "g1"; transcript_id "g1.t1";
    `],
  },
  scoreInvalid: {
    code: 'GTF006',
    title: 'Score is not a number',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: <score>`,
    explanation: 'The score is an integer or floating point number, or `.` when there is none. Readers convert the column to a number: HTSeq, for one, stops with a conversion error when it holds text such as `NA` or a decimal comma.',
    bad: [ex`
      chr1→example→exon→1200→1350→NA→+→.→gene_id "g1"; transcript_id "g1.t1";
    `],
  },
  strandInvalid: {
    code: 'GTF007',
    title: 'Strand is not +, - or a dot',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions (the strand column is inherited from GFF)`,
    explanation: 'The strand is `+` or `-`; `.` is used for features without a strand, such as the single-exon transcripts StringTie cannot orient. Numeric strands (`1`, `-1`) come from Ensembl tables and BioMart exports. Some tools are stricter than the format: RSEM stops at any line whose strand is not `+` or `-`.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→1→.→gene_id "g1"; transcript_id "g1.t1";
    `],
  },
  frameInvalid: {
    code: 'GTF008',
    title: 'Frame is not 0, 1, 2 or a dot',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: <frame>`,
    explanation: 'The frame of a coding feature is 0, 1 or 2: the number of bases before its first complete codon, counted from the 5\' end. Other features have `.`. Values such as 3 or -1 are reading frames from another convention.',
    bad: [ex`
      chr1→example→CDS→1299→1350→.→+→3→gene_id "g1"; transcript_id "g1.t1";
    `],
  },
  frameMissing: {
    code: 'GTF009',
    title: 'Coding feature has no frame',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, GTF Field Definitions: <feature>, <frame>`,
    explanation:
      'A `CDS` line needs a frame of 0, 1 or 2; without it a program cannot translate a transcript whose first CDS segment does not begin with a complete codon. GTF 2.2 also requires a frame on every `start_codon` and `stop_codon` line. ' +
      'Practice differs: some producers write `.` for start and stop codons, and tools in common use do not read their frame, so the default profile checks only `CDS` and the strict profile checks all three.',
    bad: [
      ex`
        chr1→example→CDS→1299→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1";
      `,
      { text: ex`
        chr1→example→start_codon→1299→1301→.→+→.→gene_id "g1"; transcript_id "g1.t1";
      `, profile: 'strict', note: 'strict only: a start codon without a frame' },
    ],
    good: [GOOD_GTF22],
  },
  inlineComment: {
    code: 'GTF010',
    title: 'Comment at the end of a feature line',
    level: 'warning',
    strict: 'off',
    spec: `${SPEC}, GTF Field Definitions: [comments]`,
    explanation:
      'GTF 2.2 allows a `#` comment after the attributes of a feature line, so the strict profile accepts it. In practice parsers do not strip it (HTSeq and RSEM, for two, hand the whole rest of the line to their attribute parser), so the comment is read as one more attribute or as part of the last value. Keep comments on lines of their own.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1"; # first exon
    `],
  },
  featureCase: {
    code: 'GTF011',
    title: 'Feature type differs from a GTF type only in capitalisation',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, GTF Field Definitions: <feature>`,
    explanation: 'Feature types are case-sensitive: `CDS`, `start_codon`, `stop_codon`, `exon`, `5UTR`, `3UTR`, `inter`, `inter_CNS`, `intron_CNS`. A program that looks for `exon` lines finds none in a file that says `Exon`, and reports that the annotation is empty or that no reads were assigned.',
    bad: [ex`
      chr1→example→Exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1";
    `],
  },
  featureNonstandard: {
    code: 'GTF012',
    title: 'Feature type is not defined by GTF 2.2',
    level: 'off',
    strict: 'warning',
    spec: `${SPEC}, GTF Field Definitions: <feature>`,
    explanation:
      'GTF 2.2 defines nine feature types (`CDS`, `start_codon`, `stop_codon`, `exon`, `5UTR`, `3UTR`, `inter`, `inter_CNS`, `intron_CNS`) and says every other type is ignored. ' +
      'Ensembl and GENCODE files add `gene`, `transcript`, `five_prime_utr`, `three_prime_utr`, `UTR` and `Selenocysteine` lines, and the tools in common use expect or accept them, so this is reported only in the strict profile, as a warning.',
    bad: [{ text: ex`
      chr1→example→transcript→1200→2100→.→+→.→gene_id "g1"; transcript_id "g1.t1";
      chr1→example→exon→1200→2100→.→+→.→gene_id "g1"; transcript_id "g1.t1";
    `, profile: 'strict' }],
  },

  // ---------------------------------------------------------------- attributes
  gff3StyleAttributes: {
    code: 'GTF101',
    title: 'Attributes are written in GFF3 style',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation:
      'This line writes its attributes as `ID=X;Parent=Y`, which is the GFF3 convention. GTF writes `gene_id "X"; transcript_id "Y";`. The first eight columns of the two formats look alike, but a GTF parser finds no `gene_id` in such a file: read counters report that no features were found. ' +
      'If the file is meant to be GFF3, rename it to `.gff3` (or check it with `--type gff3`); to get GTF, convert it with `gffread in.gff3 -T -o out.gtf` or `agat_convert_sp_gff2gtf.pl`.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→ID=exon1;Parent=tx1
    `],
  },
  attributeMalformed: {
    code: 'GTF102',
    title: 'Attribute is not a key followed by a value',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation: 'Each attribute is a key, a space and a value, ended by a semicolon: `gene_id "g1";`. A key with nothing after it, or a value with no key in front, cannot be read, and parsers stop at the line.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id;
    `],
  },
  semicolonMissing: {
    code: 'GTF103',
    title: 'No semicolon between two attributes',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation:
      'Every attribute ends with a semicolon. Without it the next key is read as part of the value, or the parser gives up: HTSeq stops with "The attribute string seems to contain mismatched quotes" or "Failure parsing GFF attribute line". ' +
      'The same symptom appears when a value itself contains a double quote, because the value then ends early.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id "g1" transcript_id "g1.t1";
    `],
    good: [GOOD_GTF22],
  },
  finalSemicolonMissing: {
    code: 'GTF104',
    title: 'Last attribute does not end with a semicolon',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation: 'The last attribute of a line needs its semicolon too. Parsers generally accept the line without it, and HTSeq itself writes such lines (the annotation DEXSeq prepares, for example), which is why this is a warning by default.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1"
    `],
  },
  unclosedQuote: {
    code: 'GTF105',
    title: 'Quoted value is never closed',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation: 'A value that begins with a double quote must end with one. When the closing quote is missing, the rest of the line, including the following attributes, becomes part of the value.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1;
    `],
  },
  unquotedValue: {
    code: 'GTF106',
    title: 'Text value is not in double quotes',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation: 'Values that are text are written in double quotes: `gene_id "g1";`. Numbers may stand alone, as in GENCODE\'s `level 2;`. HTSeq accepts unquoted text, but RSEM stops when `gene_id` or `transcript_id` is not quoted, and an unquoted value cannot contain a space.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id g1; transcript_id g1.t1;
    `],
    good: [GOOD_ENSEMBL],
  },
  attributeSeparator: {
    code: 'GTF107',
    title: 'Attributes are not separated by exactly one space',
    level: 'off',
    strict: 'warning',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation: 'GTF 2.2 asks for exactly one space between the semicolon that ends an attribute and the next key. Parsers that honour quotes read files without the space (`gene_id "g1";transcript_id "t1";`) or with several all the same, so this is reported only in the strict profile.',
    bad: [{ text: ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id "g1";transcript_id "g1.t1";
    `, profile: 'strict' }],
  },
  geneIdMissing: {
    code: 'GTF108',
    title: 'Feature has no gene_id',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation:
      'Every feature line carries a `gene_id` attribute; it is what makes a GTF file different from a plain GFF2 file. Read counters group exons by it: featureCounts stops with "failed to find the gene identifier attribute" and HTSeq with "Feature ... does not contain a \'gene_id\' attribute". ' +
      'An empty value (`gene_id "";`) is allowed for features that belong to no gene.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→transcript_id "g1.t1"; gene_name "ABC1";
    `],
  },
  transcriptIdMissing: {
    code: 'GTF109',
    title: 'Transcript feature has no transcript_id',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation:
      'Exons, coding segments, codons and UTRs belong to a transcript, named by `transcript_id`. Without it, tools that build transcript models cannot tell which exons go together: RSEM stops with "Cannot find transcript_id!". ' +
      'Files written for gene-level counting only sometimes omit it; add the transcript, or use the gene identifier when each gene has one transcript.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id "g1"; gene_name "ABC1";
    `],
  },
  geneLineWithoutTranscriptId: {
    code: 'GTF110',
    title: 'Line of a feature type outside GTF 2.2 has no transcript_id',
    level: 'off',
    strict: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation:
      'GTF 2.2 requires both `gene_id` and `transcript_id` on every line and writes `transcript_id "";` when a feature belongs to no transcript. Ensembl and GENCODE `gene` lines have no `transcript_id` at all, and the tools in common use accept that, so the default profile does not report it. ' +
      'A file that must satisfy a GTF 2.2 parser needs `transcript_id "";` on those lines.',
    bad: [{ text: ex`
      chr1→example→gene→1200→2100→.→+→.→gene_id "g1"; gene_name "ABC1";
      chr1→example→exon→1200→2100→.→+→.→gene_id "g1"; transcript_id "g1.t1";
    `, profile: 'strict' }],
  },
  mandatoryAttributesNotFirst: {
    code: 'GTF111',
    title: 'gene_id and transcript_id are not the first two attributes',
    level: 'off',
    strict: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes]`,
    explanation: 'GTF 2.2 puts `gene_id` first and `transcript_id` second, before any other attribute. Parsers in current use look attributes up by name, and Ensembl files place `gene_version` between the two, so the order is checked only in the strict profile.',
    bad: [{ text: ex`
      chr1→example→exon→1200→1350→.→+→.→exon_number 1; gene_id "g1"; transcript_id "g1.t1";
    `, profile: 'strict' }],
  },

  // ---------------------------------------------------------------- transcripts
  transcriptMultipleSeqids: {
    code: 'GTF201',
    title: 'Transcript has features on more than one sequence',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes] (transcript_id)`,
    explanation:
      'All features of one transcript lie on one sequence. When the same `transcript_id` appears on two, the file really contains two transcripts with one name: RSEM stops with "has exons on multiple chromosomes!", and tools that do not stop merge the two loci into one model. ' +
      'Known sources are UCSC table-browser exports of RefSeq, where one accession maps to several chromosomes or alternative haplotypes, and old GENCODE releases, which repeat the pseudoautosomal genes on chrX and chrY under the same identifiers. Make the identifiers unique, for example by adding a suffix on the second locus.',
    bad: [ex`
      chrX→example→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1";
      chrY→example→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1";
    `],
  },
  transcriptBothStrands: {
    code: 'GTF202',
    title: 'Transcript has features on both strands',
    level: 'error',
    spec: `${SPEC}, GTF Field Definitions: [attributes] (transcript_id)`,
    explanation: 'A transcript is read from one strand, so all its exons have the same strand. Mixed strands mean either that two transcripts share a `transcript_id` or that the strand column of some lines is wrong. RSEM stops with "has exons from different orientations!" and GenomeTools refuses to convert the file. A transcript that is annotated across both strands on purpose (a trans-spliced gene such as mod(mdg4) in Drosophila) is reported as well, because the same tools fail on it; such transcripts are usually removed before quantification.',
    bad: [ex`
      chr1→example→exon→1200→1350→.→+→.→gene_id "g1"; transcript_id "g1.t1";
      chr1→example→exon→1500→1618→.→-→.→gene_id "g1"; transcript_id "g1.t1";
    `],
  },
  stopCodonInCds: {
    code: 'GTF203',
    title: 'Stop codon is included in the CDS',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, GTF Field Definitions: <feature>`,
    explanation:
      'In GTF the `CDS` ends at the last amino-acid codon and the `stop_codon` feature follows it. (GFF3 and GenBank do the opposite and include the stop codon in the CDS.) A file that has `stop_codon` lines inside its CDS was probably converted from GFF3 without adjusting the coordinates; tools that add the stop codon themselves then produce a CDS three bases too long, and GenomeTools refuses the file.',
    bad: [ex`
      chr1→example→CDS→1299→1350→.→+→0→gene_id "g1"; transcript_id "g1.t1";
      chr1→example→stop_codon→1348→1350→.→+→0→gene_id "g1"; transcript_id "g1.t1";
    `],
    good: [GOOD_GTF22],
  },
});
