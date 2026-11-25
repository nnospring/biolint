import { defineRules, ex } from '../../core/rules.ts';

// Section names refer to "Generic Feature Format Version 3 (GFF3)", version 1.26 (Sequence Ontology project,
// The-Sequence-Ontology/Specifications, gff3.md).
const SPEC = 'GFF3 1.26';

const GOOD_GENE = ex`
  ##gff-version 3
  ##sequence-region chr1 1 50000
  chr1→example→gene→2100→7400→.→+→.→ID=gene1;Name=abcA
  chr1→example→mRNA→2100→7400→.→+→.→ID=tx1;Parent=gene1
  chr1→example→exon→2100→2600→.→+→.→Parent=tx1
  chr1→example→exon→4000→7400→.→+→.→Parent=tx1
  chr1→example→CDS→2300→2600→.→+→0→ID=cds1;Parent=tx1
  chr1→example→CDS→4000→4701→.→+→2→ID=cds1;Parent=tx1
`;

const GOOD_FORWARD = ex`
  ##gff-version 3
  chr1→example→exon→2100→2600→.→+→.→Parent=tx1
  chr1→example→mRNA→2100→7400→.→+→.→ID=tx1;Parent=gene1
  chr1→example→gene→2100→7400→.→+→.→ID=gene1
  ###
  chr1→example→gene→12000→15000→.→-→.→ID=gene2
`;

const GOOD_FASTA = ex`
  ##gff-version 3.1.26
  ctgA→example→gene→3→20→.→+→.→ID=gene1
  ##FASTA
  >ctgA
  ACGTACGTACGTACGTACGTACGT
`;

const GOOD_ALIGNMENT = ex`
  ##gff-version 3
  scaffold7→aligner→cDNA_match→2001→2460→97.5→+→.→ID=aln1;Target=mrna0042 1 448;Gap=M210 D12 M238
  scaffold7→aligner→cDNA_match→6100→6385→3.1e-30→-→.→ID=aln2;Target=mrna0077 15 300 +
  scaffold7→aligner→cDNA_match→7020→7339→2.4e-35→-→.→ID=aln2;Target=mrna0077 301 620 +
`;

const GOOD_CIRCULAR = ex`
  ##gff-version 3
  ##sequence-region pX01 1 4821
  pX01→example→region→1→4821→.→+→.→ID=pX01;Is_circular=true
  pX01→example→CDS→4500→5120→.→+→0→ID=cds1;Name=repA
`;

/** Valid files used by tests: none of them may produce any diagnostic, in either profile. */
export const GOOD_GFF3_EXAMPLES = [GOOD_GENE, GOOD_FORWARD, GOOD_FASTA, GOOD_ALIGNMENT, GOOD_CIRCULAR];

export const G = defineRules('gff3', {
  // ---------------------------------------------------------------- directives
  versionMissing: {
    code: 'GFF001',
    title: 'File does not declare ##gff-version 3',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Other Syntax: ##gff-version`,
    explanation:
      'A GFF3 file must begin with the line `##gff-version 3`. The extension `.gff` is shared by GFF3, GFF2 and GTF, which differ in how column 9 is written, so this line is the only reliable way for a program to know which one it has. ' +
      'Most tools assume GFF3 when it is missing, which is why this is a warning by default; GenomeTools and other strict parsers refuse the file. It usually goes missing when a file is filtered with `grep -v "^#"` or assembled by a script.',
    bad: [ex`
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
    `],
    good: [GOOD_GENE],
  },
  versionInvalid: {
    code: 'GFF002',
    title: '##gff-version is not version 3',
    level: 'error',
    spec: `${SPEC}, Other Syntax: ##gff-version`,
    explanation:
      'The version is written `3`, optionally followed by a revision as in `3.1.26`, and separated from `##gff-version` by a space. ' +
      'A file that declares version 2 is GFF2 or GTF: its ninth column uses `key "value";` pairs, and it has to be converted (for example with `gffread` or AGAT) before a GFF3 tool can read it.',
    bad: [
      { text: ex`
        ##gff-version 2
        chr1→example→gene→2100→7400→.→+→.→ID=gene1
      `, note: 'the file says it is GFF2' },
      { text: ex`
        ##gff-version3
        chr1→example→gene→2100→7400→.→+→.→ID=gene1
      `, note: 'no space before the version' },
    ],
  },
  versionNotFirst: {
    code: 'GFF003',
    title: '##gff-version is not the first line',
    level: 'off',
    strict: 'error',
    spec: `${SPEC}, Other Syntax: ##gff-version`,
    explanation:
      'The specification requires `##gff-version` to be the topmost line of the file. Comments, blank lines or other directives above it are tolerated by nearly every parser, so this is only reported in the strict profile.',
    bad: [{ text: ex`
      # exported 2024-05-01
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
    `, profile: 'strict' }],
  },
  versionRepeated: {
    code: 'GFF004',
    title: '##gff-version appears more than once',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Change Log 1.21`,
    explanation:
      'A second `##gff-version` line almost always means that two GFF3 files were joined with `cat`. The joined file may then contain the same ID twice and `##sequence-region` lines in the middle of the features. ' +
      'Merge annotation files with a tool that understands the format, such as `gt gff3 -sort` or `agat_sp_merge_annotations.pl`.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
      ##gff-version 3
      chr2→example→gene→500→800→.→-→.→ID=gene2
    `],
  },
  sequenceRegionInvalid: {
    code: 'GFF005',
    title: '##sequence-region is not "seqid start end"',
    level: 'error',
    spec: `${SPEC}, Other Syntax: ##sequence-region`,
    explanation:
      'The directive names a sequence and its extent: `##sequence-region chr1 1 248956422`. Start and end are positive integers with start not after end. Parsers use it for bounds checking and genome browsers use it to size the sequence, so a malformed line is either rejected or silently ignored.',
    bad: [
      ex`
        ##gff-version 3
        ##sequence-region chr1 50000
        chr1→example→gene→2100→7400→.→+→.→ID=gene1
      `,
      { text: ex`
        ##gff-version 3
        ##sequence-region chr1 50000 1
        chr1→example→gene→2100→7400→.→+→.→ID=gene1
      `, note: 'start and end are swapped' },
    ],
  },
  sequenceRegionDuplicate: {
    code: 'GFF006',
    title: 'Two ##sequence-region lines for the same sequence',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Other Syntax: ##sequence-region`,
    explanation: 'Only one `##sequence-region` directive may be given for a sequence. Two of them usually come from concatenating files; which one a parser keeps is not defined. biolint checks features against the first.',
    bad: [ex`
      ##gff-version 3
      ##sequence-region chr1 1 50000
      ##sequence-region chr1 1 60000
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
    `],
  },
  featureOutsideRegion: {
    code: 'GFF007',
    title: 'Feature lies outside its ##sequence-region',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Other Syntax: ##sequence-region`,
    explanation:
      'When a `##sequence-region` is given for a sequence, every feature on it must lie inside that range. A feature beyond the end usually means the annotation and the directive come from different assemblies, or the file was cut from a larger one without adjusting the directive. ' +
      'The one exception is a circular sequence: when its landmark feature carries `Is_circular=true`, a feature that crosses the origin has an end beyond the sequence length.',
    bad: [ex`
      ##gff-version 3
      ##sequence-region chr1 1 5000
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
    `],
    good: [GOOD_CIRCULAR],
  },
  fastaSectionContent: {
    code: 'GFF008',
    title: 'Feature or directive after ##FASTA',
    level: 'error',
    spec: `${SPEC}, Other Syntax: ##FASTA`,
    explanation:
      '`##FASTA` ends the annotation part of the file: everything after it must be FASTA sequence, and all sequences must be together at the end. A parser that follows the specification stops reading features at `##FASTA`, so feature lines placed after it are lost without a message. ' +
      'This happens when annotation files that each embed their sequence (Prokka output, for example) are concatenated.',
    bad: [ex`
      ##gff-version 3
      ctgA→example→gene→3→20→.→+→.→ID=gene1
      ##FASTA
      >ctgA
      ACGTACGTACGTACGTACGTACGT
      ctgA→example→gene→5→18→.→-→.→ID=gene2
    `],
    good: [GOOD_FASTA],
  },

  // ---------------------------------------------------------------- columns
  columnCount: {
    code: 'GFF101',
    title: 'Feature line does not have nine tab-separated columns',
    level: 'error',
    spec: `${SPEC}, Description of the Format`,
    explanation:
      'Every feature line has exactly nine columns separated by single tab characters: seqid, source, type, start, end, score, strand, phase, attributes. Spaces are legal inside values, so parsers split on tabs only. ' +
      'The usual cause is an editor or a copy-paste that turned tabs into spaces (HTSeq and GenomeTools both stop at such a line); a missing ninth column (write `.` when there are no attributes) and a line break inside a value are the others.',
    bad: [
      { text: ex`
        ##gff-version 3
        chr1 example gene 1000 9000 . + . ID=gene1
      `, note: 'separated by spaces' },
      { text: ex`
        ##gff-version 3
        chr1→example→gene→2100→7400→.→+→.
      `, note: 'no attributes column' },
    ],
    good: [GOOD_GENE],
  },
  trailingTab: {
    code: 'GFF102',
    title: 'Line ends with an extra tab',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Description of the Format`,
    explanation: 'A tab after the attributes column creates an empty tenth column. A parser that takes the first nine fields ignores it; one that counts columns rejects the line. Spreadsheet exports and scripts that append `"\\t"` to every field produce it.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1→
    `],
  },
  emptyField: {
    code: 'GFF103',
    title: 'Empty column',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Description of the Format`,
    explanation: 'A column may not be left empty: a value that is unknown or does not apply is written as a single `.`. Empty columns appear when a script joins fields that contain missing values, and parsers that split on runs of whitespace then see a shifted line.',
    bad: [ex`
      ##gff-version 3
      chr1→→gene→2100→7400→.→+→.→ID=gene1
    `],
  },
  seqidInvalid: {
    code: 'GFF104',
    title: 'Sequence ID contains whitespace',
    level: 'error',
    spec: `${SPEC}, Column 1: "seqid"`,
    explanation:
      'The first column names the sequence the feature is on, and it may not contain unescaped whitespace. FASTA readers cut a sequence name at the first space, so a seqid such as `chr1 Homo sapiens` never matches the sequence `chr1` and every feature on it is dropped by tools that join annotation and sequence.',
    bad: [ex`
      ##gff-version 3
      chr1 Homo sapiens→example→gene→2100→7400→.→+→.→ID=gene1
    `],
  },
  seqidCharacters: {
    code: 'GFF105',
    title: 'Sequence ID contains a character that must be escaped',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Column 1: "seqid"`,
    explanation:
      'A seqid may contain letters, digits and `. : ^ * $ @ ! + _ ? - |`; any other character has to be percent-encoded (a comma as `%2C`, for example). Tools generally accept other characters, but names with `,`, `;`, `=`, `/` or parentheses break region strings, file names derived from sequence names, and tabix queries.',
    bad: [ex`
      ##gff-version 3
      scaffold(12)→example→gene→2100→7400→.→+→.→ID=gene1
    `],
  },
  coordinateInvalid: {
    code: 'GFF106',
    title: 'Start or end is not a positive integer',
    level: 'error',
    spec: `${SPEC}, Columns 4 & 5: "start" and "end"`,
    explanation:
      'Start and end are whole numbers counted from 1: the first base of a sequence is 1, and both ends are included. A 0 usually comes from BED, which counts starts from 0; `1e+05` and `1,000` are spreadsheet artefacts. Parsers stop at such a value or read it as something else.',
    bad: [
      { text: ex`
        ##gff-version 3
        chr1→example→gene→0→7400→.→+→.→ID=gene1
      `, note: 'a 0-based start' },
      ex`
        ##gff-version 3
        chr1→example→gene→2100→1e+05→.→+→.→ID=gene1
      `,
    ],
  },
  startAfterEnd: {
    code: 'GFF107',
    title: 'Start is greater than end',
    level: 'error',
    spec: `${SPEC}, Columns 4 & 5: "start" and "end"`,
    explanation:
      'Start is always less than or equal to end, also for features on the minus strand: the strand column gives the direction, not the order of the coordinates. ' +
      'A feature that crosses the origin of a circular sequence is written with end = its true end + the length of the sequence, so that start stays below end.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→7400→2100→.→-→.→ID=gene1
    `],
    good: [GOOD_CIRCULAR],
  },
  scoreInvalid: {
    code: 'GFF108',
    title: 'Score is not a number',
    level: 'error',
    spec: `${SPEC}, Column 6: "score"`,
    explanation: 'The score is a floating point number, or `.` when there is none. Readers convert the column to a number: HTSeq, for one, stops with a conversion error when it holds text such as `NA` or a decimal comma.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→0,95→+→.→ID=gene1
    `],
  },
  strandInvalid: {
    code: 'GFF109',
    title: 'Strand is not +, -, . or ?',
    level: 'error',
    spec: `${SPEC}, Column 7: "strand"`,
    explanation: 'The strand is `+`, `-`, `.` for a feature without a strand, or `?` when the strand matters but is unknown. Numeric strands (`1`, `-1`) come from Ensembl tables and BioMart exports. GenomeTools rejects any other value, and a tool that does not reject it cannot know which strand to extract.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→-1→.→ID=gene1
    `],
  },
  phaseInvalid: {
    code: 'GFF110',
    title: 'Phase is not 0, 1, 2 or a dot',
    level: 'error',
    spec: `${SPEC}, Column 8: "phase"`,
    explanation: 'The phase is the number of bases (0, 1 or 2) to skip from the 5\' end of a CDS segment to reach the first complete codon, or `.` for features that are not coding. It is not the reading frame (which can be written 1-3 or -1 to -3 in other formats).',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
      chr1→example→CDS→2300→2600→.→+→3→Parent=gene1
    `],
  },
  cdsPhaseMissing: {
    code: 'GFF111',
    title: 'CDS feature has no phase',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Column 8: "phase"`,
    explanation:
      'Every CDS line needs a phase of 0, 1 or 2. Without it a program cannot translate a CDS whose first segment does not start with a complete codon, and tools that derive protein sequences either assume 0 or skip the feature. ' +
      'For a CDS in a single piece that starts at the start codon the phase is 0.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
      chr1→example→CDS→2300→2600→.→+→.→Parent=gene1
    `],
    good: [GOOD_GENE],
  },
  percentEscapeInvalid: {
    code: 'GFF112',
    title: 'Percent sign is not part of an escape',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Description of the Format`,
    explanation: 'GFF3 uses URL-style escapes: `%` followed by two hexadecimal digits stands for one character (`%3B` is a semicolon). A literal percent sign must therefore be written `%25`. What a parser makes of text such as `95% identity` is not defined: the `%` may be kept, dropped, or decoded together with the two characters after it.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;Note=95% identity to abcA
    `],
    good: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;Note=95%25 identity to abcA%3B curated
    `],
  },

  // ---------------------------------------------------------------- attributes
  attributeMalformed: {
    code: 'GFF201',
    title: 'Attribute is not tag=value',
    level: 'error',
    spec: `${SPEC}, Column 9: "attributes"`,
    explanation:
      'Column 9 is a list of `tag=value` pairs separated by semicolons. An entry without `=`, or without a tag before it, cannot be read. ' +
      'The usual cause is a semicolon inside a value (a description such as `kinase; putative`), which splits the value in two: write the semicolon as `%3B`.',
    bad: [
      { text: ex`
        ##gff-version 3
        chr1→example→gene→2100→7400→.→+→.→ID=gene1;Note=kinase; putative
      `, note: 'a semicolon inside the Note splits it' },
      ex`
        ##gff-version 3
        chr1→example→gene→2100→7400→.→+→.→ID=gene1;=abcA
      `,
    ],
  },
  gtfStyleAttributes: {
    code: 'GFF202',
    title: 'Attributes are written in GTF/GFF2 style',
    level: 'error',
    spec: `${SPEC}, Column 9: "attributes"`,
    explanation:
      'This line writes its attributes as `gene_id "X"; transcript_id "Y";`, which is the GTF (GFF version 2) convention. GFF3 writes `ID=X;Parent=Y`. The two formats share the first eight columns and often the `.gff` extension, but a GFF3 parser finds no ID or Parent in such a file and loses the gene structure. ' +
      'If the file is meant to be GTF, rename it to `.gtf` (or check it with `--type gtf`); to get GFF3, convert it with `gffread in.gtf -o out.gff3` or `agat_convert_sp_gxf2gxf.pl`.',
    bad: [ex`
      ##gff-version 3
      chr1→example→exon→2100→2600→.→+→.→gene_id "gene1"; transcript_id "tx1";
    `],
  },
  attributeValueEmpty: {
    code: 'GFF203',
    title: 'Attribute has no value',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Column 9: "attributes"`,
    explanation: 'An attribute is `tag=value`; a tag followed by `=` and nothing else carries no information, and GenomeTools rejects it. Scripts that print every field of a table produce `Note=;` for missing values: leave the attribute out instead. An empty `ID=` or `Parent=` also means the feature is not linked to its gene.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;Note=
    `],
  },
  attributeDuplicate: {
    code: 'GFF204',
    title: 'Same attribute tag twice on one line',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Column 9: "attributes"`,
    explanation: 'Several values of one attribute are written once, separated by commas: `Parent=tx1,tx2`. When the tag is repeated instead, GenomeTools rejects the line, and a parser that keeps attributes in a dictionary (HTSeq, for one) retains only the last value.',
    bad: [ex`
      ##gff-version 3
      chr1→example→mRNA→2100→7400→.→+→.→ID=tx1
      chr1→example→mRNA→2100→7400→.→+→.→ID=tx2
      chr1→example→exon→2100→2600→.→+→.→Parent=tx1;Parent=tx2
    `],
    good: [ex`
      ##gff-version 3
      chr1→example→mRNA→2100→7400→.→+→.→ID=tx1
      chr1→example→mRNA→2100→7400→.→+→.→ID=tx2
      chr1→example→exon→2100→2600→.→+→.→Parent=tx1,tx2
    `],
  },
  reservedTagCase: {
    code: 'GFF205',
    title: 'ID or Parent written in the wrong case',
    level: 'warning',
    spec: `${SPEC}, Column 9: "attributes"`,
    explanation:
      'Attribute names are case-sensitive: `ID` and `Parent` have a defined meaning, `id` and `parent` are ordinary free-text attributes. A file that uses the lower-case spelling is syntactically valid, which is why nothing complains, but every parser sees features with no identifier and no parent, and the gene models fall apart into unrelated lines.',
    bad: [
      ex`
        ##gff-version 3
        chr1→example→gene→2100→7400→.→+→.→id=gene1
      `,
      ex`
        ##gff-version 3
        chr1→example→gene→2100→7400→.→+→.→ID=gene1
        chr1→example→mRNA→2100→7400→.→+→.→ID=tx1;parent=gene1
      `,
    ],
  },
  reservedTagUnknown: {
    code: 'GFF206',
    title: 'Attribute starting with an upper-case letter is not a defined tag',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Column 9: "attributes"`,
    explanation:
      'Tags that begin with an upper-case letter are reserved for the specification, which defines `ID`, `Name`, `Alias`, `Parent`, `Target`, `Gap`, `Derives_from`, `Note`, `Dbxref`, `Ontology_term` and `Is_circular`. Your own attributes must start with a lower-case letter. ' +
      'Files in circulation carry such tags and tools generally pass them through, but GenomeTools rejects them, and a misspelt reserved tag (`PARENT`, `Id`, `DBxref`) is not recognised as the real one.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;Description=ABC transporter
    `],
    good: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;description=ABC transporter
    `],
  },
  multipleValuesNotAllowed: {
    code: 'GFF207',
    title: 'Comma in an attribute that takes a single value',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Column 9: "attributes"`,
    explanation: 'A comma separates several values, and among the defined tags only `Parent`, `Alias`, `Note`, `Dbxref` and `Ontology_term` may have more than one. A comma in an `ID`, `Name`, `Target`, `Gap`, `Derives_from` or `Is_circular` value is therefore read as two values. If the comma is part of the text, write it as `%2C`.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;Name=DNA polymerase III, alpha subunit
    `],
    good: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;Name=DNA polymerase III%2C alpha subunit
    `],
  },
  unescapedCharacter: {
    code: 'GFF208',
    title: 'Unescaped = or & inside an attribute value',
    level: 'off',
    strict: 'error',
    spec: `${SPEC}, Description of the Format`,
    explanation: 'The characters `;`, `=`, `&` and `,` have a reserved meaning in column 9 and must be percent-encoded when they are part of a value (`=` as `%3D`, `&` as `%26`). Most parsers split each attribute at the first `=`, so the value survives and the default profile says nothing; GenomeTools rejects an attribute with more than one `=`.',
    bad: [{ text: ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;Note=pH=7 buffer
    `, profile: 'strict' }],
  },
  quotedValue: {
    code: 'GFF209',
    title: 'Attribute value is wrapped in double quotes',
    level: 'info',
    strict: 'warning',
    spec: `${SPEC}, Column 9: "attributes"`,
    explanation: 'GFF3 values are not quoted. Quotes are kept as part of the value, so `product="kinase"` yields a product name that begins and ends with a quote character. They are a leftover of a conversion from GTF or GenBank; remove them and percent-encode `;`, `=`, `&` and `,` inside the text instead.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;product="protein kinase"
    `],
  },
  quotedValueSplit: {
    code: 'GFF210',
    title: 'Semicolon inside a quoted value splits the attribute',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Description of the Format`,
    explanation:
      'Quotes do not protect anything in GFF3: a semicolon always ends an attribute. A value such as `note="binds ATP; essential"` is therefore cut after `ATP`, and the rest becomes a separate, meaningless attribute. Converters from GenBank or GTF that copy quoted text produce this. Write the semicolon as `%3B` and drop the quotes.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;note="binds ATP; essential"
    `],
    good: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1;note=binds ATP%3B essential
    `],
  },
  attributeWhitespace: {
    code: 'GFF211',
    title: 'Space before an attribute tag',
    level: 'warning',
    spec: `${SPEC}, Column 9: "attributes"`,
    explanation: 'Attributes are separated by a semicolon alone. With `ID=gene1; Parent=x` the second tag is ` Parent`, with a leading space, and parsers that compare tags exactly do not recognise it as `Parent`. The space comes from files written in the GTF habit of `; ` separators.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1; Name=abcA
    `],
  },
  targetInvalid: {
    code: 'GFF212',
    title: 'Target is not "target_id start end [strand]"',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Column 9: "attributes" (Target)`,
    explanation:
      'The `Target` of an alignment is the name of the aligned sequence, its start and end in that sequence, and optionally a strand, separated by single spaces: `Target=mrna0042 1 448 +`. Start is not after end; the direction is given by the strand, not by swapping the coordinates. ' +
      'Old files join the parts with `+` instead of spaces, which is no longer allowed. GenomeTools rejects a Target that does not have three or four parts, or whose start is after its end.',
    bad: [
      ex`
        ##gff-version 3
        scaffold7→aligner→cDNA_match→2001→2460→.→+→.→ID=aln1;Target=mrna0042
      `,
      { text: ex`
        ##gff-version 3
        scaffold7→aligner→cDNA_match→2001→2460→.→+→.→ID=aln1;Target=mrna0042+1+448
      `, note: 'the deprecated `+` separator' },
    ],
    good: [GOOD_ALIGNMENT],
  },
  gapInvalid: {
    code: 'GFF213',
    title: 'Gap is not a list of operations such as "M210 D12 M238"',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, The Gap Attribute`,
    explanation: 'A `Gap` describes an alignment as operations separated by spaces, each a letter (`M` match, `I` insertion, `D` deletion, `F` and `R` frameshifts) followed by a length: `M210 D12 M238`. This is the reverse of SAM CIGAR strings, where the number comes first and nothing separates the operations.',
    bad: [ex`
      ##gff-version 3
      scaffold7→aligner→cDNA_match→2001→2460→.→+→.→ID=aln1;Target=mrna0042 1 448;Gap=210M12D238M
    `],
    good: [GOOD_ALIGNMENT],
  },
  isCircularInvalid: {
    code: 'GFF214',
    title: 'Is_circular is not "true"',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Circular Genomes`,
    explanation: '`Is_circular=true` on the feature that represents a whole chromosome or plasmid marks it as circular, which allows features to cross its origin. It is a flag: the value is `true` (or `false`), in lower case.',
    bad: [ex`
      ##gff-version 3
      pX01→example→region→1→4821→.→+→.→ID=pX01;Is_circular=yes
    `],
    good: [GOOD_CIRCULAR],
  },

  // ---------------------------------------------------------------- relationships
  idDuplicate: {
    code: 'GFF301',
    title: 'ID is used by two different features',
    level: 'error',
    spec: `${SPEC}, Column 9: "attributes" (ID)`,
    explanation:
      'An ID must be unique in the file. The same ID may appear on several lines only when those lines are the pieces of one discontinuous feature, such as a CDS spread over several exons: they then have the same type and lie on the same sequence. ' +
      'An ID shared by a gene and its mRNA, or by features on different sequences, makes every `Parent` that refers to it ambiguous, and GenomeTools stops at the second use. Concatenated files and scripts that number features per chromosome are the usual sources.',
    bad: [
      { text: ex`
        ##gff-version 3
        chr1→example→gene→2100→7400→.→+→.→ID=abcA
        chr1→example→mRNA→2100→7400→.→+→.→ID=abcA
      `, note: 'a gene and an mRNA with the same ID' },
      { text: ex`
        ##gff-version 3
        chr1→example→gene→2100→7400→.→+→.→ID=gene1
        chr2→example→gene→500→800→.→+→.→ID=gene1
      `, note: 'the same ID on two sequences' },
    ],
    good: [GOOD_GENE],
  },
  idRepeatedSameLocation: {
    code: 'GFF302',
    title: 'Feature appears twice with the same ID and location',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Column 9: "attributes" (ID)`,
    explanation: 'Lines that share an ID are the parts of one feature at several locations. Two lines with the same ID, type and coordinates are not two parts: the feature has been written twice, typically because a file was concatenated with itself or a merge did not remove duplicates.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
    `],
  },
  parentUnresolved: {
    code: 'GFF303',
    title: 'Parent refers to an ID that is not in the file',
    level: 'error',
    spec: `${SPEC}, Parent (part_of) Relationships`,
    explanation:
      'A `Parent` value must be the `ID` of another feature. The parent may come later in the file, so this is decided at the end of the file or at a `###` line, which declares that everything above it is complete. ' +
      'An exon whose transcript is missing cannot be assembled into a gene model, and GenomeTools stops with \"was not defined\". The parent is usually lost by filtering lines with `grep` or by subsetting a region; a typo or a difference in case (`Gene1` and `gene1`) is the other cause.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
      chr1→example→mRNA→2100→7400→.→+→.→ID=tx1;Parent=gene01
    `],
    good: [GOOD_FORWARD],
  },
  parentDifferentSeqid: {
    code: 'GFF304',
    title: 'Feature and its Parent are on different sequences',
    level: 'error',
    spec: `${SPEC}, Parent (part_of) Relationships`,
    explanation:
      '`Parent` states that a feature is part of another one, and their coordinates are only comparable on the same sequence. An exon on `chr2` whose transcript is on `chr1` is rejected by GenomeTools and gives nonsense when a tool computes introns or extracts the spliced sequence. ' +
      'It nearly always means that IDs were reused across sequences (numbered per chromosome, say) and a child found the wrong parent.',
    bad: [ex`
      ##gff-version 3
      chr1→example→mRNA→2100→7400→.→+→.→ID=tx1
      chr2→example→exon→2100→2600→.→+→.→Parent=tx1
    `],
  },
  parentCycle: {
    code: 'GFF305',
    title: 'Parent relationships form a cycle',
    level: 'error',
    spec: `${SPEC}, Parent (part_of) Relationships`,
    explanation: 'A feature cannot be part of itself, directly or through other features. Programs that walk from a feature to its parents never finish on such a file, so parsers are required to reject it. The simplest case is a feature whose `Parent` is its own `ID`.',
    bad: [
      ex`
        ##gff-version 3
        chr1→example→gene→2100→7400→.→+→.→ID=gene1;Parent=gene1
      `,
      { text: ex`
        ##gff-version 3
        chr1→example→gene→2100→7400→.→+→.→ID=gene1;Parent=tx1
        chr1→example→mRNA→2100→7400→.→+→.→ID=tx1;Parent=gene1
      `, note: 'two features that are each other\'s parent' },
    ],
  },
  closedByTerminator: {
    code: 'GFF306',
    title: 'Feature refers across a ### line',
    level: 'warning',
    strict: 'error',
    spec: `${SPEC}, Other Syntax: ###`,
    explanation:
      'A `###` line declares that all features above it are complete: nothing below will name them as `Parent` or continue them with the same ID. Programs that read a file gene by gene release what they have at each `###`, so a child placed after it never finds its parent. ' +
      'This happens when `###` lines are kept while the features are re-sorted, or inserted at fixed intervals instead of between genes.',
    bad: [ex`
      ##gff-version 3
      chr1→example→gene→2100→7400→.→+→.→ID=gene1
      ###
      chr1→example→mRNA→2100→7400→.→+→.→ID=tx1;Parent=gene1
    `],
    good: [GOOD_FORWARD],
  },
});
