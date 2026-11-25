import { defineRules, ex } from '../core/rules.ts';

/** Rules that apply to every text format: encoding, line endings, containers, format detection. */
export const T = defineRules('text', {
  utf16: {
    code: 'TXT001',
    title: 'File is UTF-16, not UTF-8',
    level: 'error',
    explanation:
      'The file starts with a UTF-16 byte-order mark or has a NUL in every other byte. Bioinformatics tools read bytes as ASCII/UTF-8 and will see garbage. ' +
      'This usually happens after saving from Windows Notepad ("Unicode"), PowerShell redirection (`>`), or Excel "Unicode Text".',
  },
  utf8Bom: {
    code: 'TXT002',
    title: 'File starts with a UTF-8 byte-order mark',
    level: 'warning',
    fixable: true,
    explanation:
      'The three bytes EF BB BF sit in front of the first character. They are invisible in editors, but parsers see them as part of the first field, ' +
      'so `##fileformat`, `>` or `@HD` no longer match. Usually added by Windows editors or Excel "CSV UTF-8".',
  },
  crlf: {
    code: 'TXT003',
    title: 'Windows (CRLF) line endings',
    level: 'warning',
    fixable: true,
    maxShown: 1,
    explanation:
      'Lines end with carriage return + line feed. Most Unix tools keep the carriage return as part of the last field, which silently changes sample names, ' +
      'INFO values, sequence lengths and quality strings. Convert with `biolint --fix`, `dos2unix`, or `sed -i \'s/\\r$//\'`.',
    bad: [{ text: '>seq1\r\nACGT\r\n' }],
    good: ['>seq1\nACGT\n'],
  },
  mixedLineEndings: {
    code: 'TXT004',
    title: 'Mixed LF and CRLF line endings',
    level: 'warning',
    fixable: true,
    explanation: 'Some lines end with LF and others with CRLF, typically after concatenating files edited on different systems.',
    bad: [{ text: '>seq1\r\nACGT\n>seq2\nACGT\n' }],
  },
  bareCr: {
    code: 'TXT005',
    title: 'Carriage return inside a line',
    level: 'error',
    explanation:
      'A carriage return that is not followed by a line feed. Files with classic Mac OS line endings (CR only) look like one enormous line to every modern tool. ' +
      'Convert with `mac2unix` or `tr \'\\r\' \'\\n\'`.',
    bad: [{ text: '>seq1\rACGT\n' }],
  },
  invalidUtf8: {
    code: 'TXT006',
    title: 'Invalid UTF-8 byte sequence',
    level: 'error',
    explanation:
      'The bytes are not valid UTF-8. The file was probably written in a legacy encoding (Latin-1, Windows-1252, GBK, Shift-JIS) or was truncated in the middle of a character. ' +
      'Re-encode with `iconv -f <encoding> -t UTF-8`.',
  },
  controlCharacter: {
    code: 'TXT007',
    title: 'Control character in text',
    level: 'error',
    explanation:
      'A NUL or other control character appears in the text. NUL bytes usually mean the file is binary, was preallocated and never fully written, or was corrupted in transfer.',
    bad: [{ text: '>seq1\nAC\x00GT\n' }],
  },
  suspiciousUnicode: {
    code: 'TXT008',
    title: 'Look-alike Unicode character where ASCII was meant',
    level: 'warning',
    fixable: true,
    explanation:
      'A character that looks like ordinary punctuation or a space but is a different code point: curly quotes and long dashes from word processors, no-break and zero-width spaces from web pages and PDFs, ' +
      'or full-width punctuation typed with a CJK input method. Parsers compare bytes, so `；` is not `;` and `”` does not close a `"`.',
    bad: [{ text: '>seq1\u00a0sample A\nACGT\n', note: 'no-break space after the identifier' }],
  },
  noFinalNewline: {
    code: 'TXT009',
    title: 'File does not end with a newline',
    level: 'warning',
    fixable: true,
    explanation:
      'The last line has no terminating newline. Concatenating such files glues the last record of one onto the first record of the next, and some parsers drop an unterminated last line. ' +
      'It can also mean the file was truncated.',
    bad: [{ text: '>seq1\nACGT' }],
    good: ['>seq1\nACGT\n'],
  },
  finalNewlineRequired: {
    code: 'TXT014',
    title: 'Last line is not terminated, which this format requires',
    level: 'warning',
    strict: 'error',
    fixable: true,
    explanation:
      'Reported instead of TXT009 for formats whose specification says the last line must end with a line separator (VCF 4.3 and later: "the last data line must end with a line separator"). ' +
      'Parsers generally cope, but the file does not conform, and a missing terminator is also what a truncated file looks like.',
    spec: 'VCF 4.3 §1.6',
    bad: [{ profile: 'strict', format: 'vcf', text: '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1\t100\t.\tA\tT\t.\t.\t.' }],
  },
  emptyFile: {
    code: 'TXT010',
    title: 'File is empty',
    level: 'error',
    explanation: 'The file has no content. Empty outputs usually come from a failed upstream step whose exit status was not checked.',
  },
  binaryData: {
    code: 'TXT011',
    title: 'File is binary or in an unsupported container',
    level: 'error',
    explanation:
      'biolint checks text formats. BAM, CRAM and BCF are binary encodings of SAM and VCF; convert to text first, for example `samtools view -h in.bam | biolint --type sam -` or `bcftools view in.bcf | biolint --type vcf -`.',
  },
  lineTooLong: {
    code: 'TXT012',
    title: 'Line is too long to check',
    level: 'error',
    explanation: 'A single line exceeds the size biolint is willing to hold in memory for this format. In tab-separated formats this almost always means missing line breaks.',
  },
  trailingBlankLines: {
    code: 'TXT013',
    title: 'Blank lines at the end of the file',
    level: 'warning',
    fixable: true,
    explanation: 'The file ends with one or more empty lines. Most parsers ignore them, but some treat an empty line as a malformed record, and line counts (`wc -l`) no longer equal record counts.',
    bad: [{ text: '>seq1\nACGT\n\n\n' }],
  },
  unknownFormat: {
    code: 'TXT020',
    title: 'Could not determine the file format',
    level: 'error',
    explanation: 'Neither the file name nor the content identifies a supported format. Pass `--type` to say which format the file is meant to be.',
  },
  extensionMismatch: {
    code: 'TXT021',
    title: 'File name suggests a different format than the content',
    level: 'warning',
    explanation:
      'The extension belongs to one format but the content clearly is another (for example GTF saved as `.gff3`, or FASTQ saved as `.fasta`). biolint checks the file as what it contains. ' +
      'Rename the file, or pass `--type` to force a format.',
  },
  gzipTruncated: {
    code: 'GZ001',
    title: 'Compressed stream is truncated or corrupt',
    level: 'error',
    explanation:
      'Decompression stopped before the end of the gzip stream. The file was cut off (interrupted download or copy, full disk, job killed while writing) or damaged. ' +
      'Everything that could be decompressed was still checked.',
  },
  bgzfNoEof: {
    code: 'GZ002',
    title: 'BGZF end-of-file marker is missing',
    level: 'warning',
    explanation:
      'A complete BGZF file ends with a fixed 28-byte empty block. Its absence is how samtools and htslib detect truncated files ("EOF marker is absent"). ' +
      'The writer was probably interrupted; regenerate the file.',
    spec: 'SAM v1 §4.1.2',
  },
  gzipNotBgzf: {
    code: 'GZ003',
    title: 'Compressed with plain gzip, not BGZF',
    level: 'info',
    explanation:
      'The file is ordinary gzip. That is readable everywhere, but tabix, `samtools faidx` and `bcftools index` need BGZF (block gzip) to seek. ' +
      'Recompress with `zcat file.gz | bgzip > file.bgz` if you plan to index it.',
  },
});

export interface UnicodeFinding {
  /** Byte index in the line. */
  index: number;
  /** Byte length of the character. */
  length: number;
  kind: 'invalid-utf8' | 'control' | 'bare-cr' | 'suspicious';
  codePoint: number;
  /** Human name for suspicious characters. */
  name?: string;
  /** ASCII replacement for suspicious characters (may be empty). */
  ascii?: string;
}

const SUSPICIOUS: Record<number, [name: string, ascii: string]> = {
  0x00a0: ['NO-BREAK SPACE', ' '],
  0x1680: ['OGHAM SPACE MARK', ' '],
  0x2000: ['EN QUAD', ' '], 0x2001: ['EM QUAD', ' '], 0x2002: ['EN SPACE', ' '], 0x2003: ['EM SPACE', ' '], 0x2004: ['THREE-PER-EM SPACE', ' '],
  0x2005: ['FOUR-PER-EM SPACE', ' '], 0x2006: ['SIX-PER-EM SPACE', ' '], 0x2007: ['FIGURE SPACE', ' '], 0x2008: ['PUNCTUATION SPACE', ' '],
  0x2009: ['THIN SPACE', ' '], 0x200a: ['HAIR SPACE', ' '], 0x202f: ['NARROW NO-BREAK SPACE', ' '], 0x205f: ['MEDIUM MATHEMATICAL SPACE', ' '],
  0x3000: ['IDEOGRAPHIC SPACE', ' '],
  0x200b: ['ZERO WIDTH SPACE', ''], 0x200c: ['ZERO WIDTH NON-JOINER', ''], 0x200d: ['ZERO WIDTH JOINER', ''], 0x2060: ['WORD JOINER', ''],
  0xfeff: ['ZERO WIDTH NO-BREAK SPACE (byte-order mark)', ''], 0x00ad: ['SOFT HYPHEN', ''],
  0x2018: ['LEFT SINGLE QUOTATION MARK', "'"], 0x2019: ['RIGHT SINGLE QUOTATION MARK', "'"], 0x201a: ['SINGLE LOW-9 QUOTATION MARK', "'"],
  0x201c: ['LEFT DOUBLE QUOTATION MARK', '"'], 0x201d: ['RIGHT DOUBLE QUOTATION MARK', '"'], 0x201e: ['DOUBLE LOW-9 QUOTATION MARK', '"'],
  0x2032: ['PRIME', "'"], 0x2033: ['DOUBLE PRIME', '"'],
  0x2010: ['HYPHEN', '-'], 0x2011: ['NON-BREAKING HYPHEN', '-'], 0x2012: ['FIGURE DASH', '-'], 0x2013: ['EN DASH', '-'], 0x2014: ['EM DASH', '-'],
  0x2015: ['HORIZONTAL BAR', '-'], 0x2212: ['MINUS SIGN', '-'],
  0xff1b: ['FULLWIDTH SEMICOLON', ';'], 0xff1a: ['FULLWIDTH COLON', ':'], 0xff0c: ['FULLWIDTH COMMA', ','], 0xff1d: ['FULLWIDTH EQUALS SIGN', '='],
  0xff02: ['FULLWIDTH QUOTATION MARK', '"'], 0xff07: ['FULLWIDTH APOSTROPHE', "'"], 0xff08: ['FULLWIDTH LEFT PARENTHESIS', '('], 0xff09: ['FULLWIDTH RIGHT PARENTHESIS', ')'],
  0xff1e: ['FULLWIDTH GREATER-THAN SIGN', '>'], 0xff1c: ['FULLWIDTH LESS-THAN SIGN', '<'], 0xff20: ['FULLWIDTH COMMERCIAL AT', '@'], 0xff0b: ['FULLWIDTH PLUS SIGN', '+'],
  0xff0d: ['FULLWIDTH HYPHEN-MINUS', '-'], 0xff0e: ['FULLWIDTH FULL STOP', '.'], 0xff0f: ['FULLWIDTH SOLIDUS', '/'], 0xff03: ['FULLWIDTH NUMBER SIGN', '#'],
  0xff5c: ['FULLWIDTH VERTICAL LINE', '|'], 0xff3f: ['FULLWIDTH LOW LINE', '_'], 0xff0a: ['FULLWIDTH ASTERISK', '*'],
  0x3001: ['IDEOGRAPHIC COMMA', ','], 0x3002: ['IDEOGRAPHIC FULL STOP', '.'],
};

/**
 * Examine a line that contains bytes outside printable ASCII + tab.
 * Returns problems in order; valid, unsuspicious UTF-8 text produces nothing.
 */
export function scanUnusualBytes(b: Uint8Array, limit = 8): UnicodeFinding[] {
  const out: UnicodeFinding[] = [];
  const n = b.length;
  for (let i = 0; i < n && out.length < limit;) {
    const c = b[i]!;
    if (c < 0x80) {
      if (c === 13) out.push({ index: i, length: 1, kind: 'bare-cr', codePoint: c });
      else if ((c < 0x20 && c !== 9) || c === 0x7f) out.push({ index: i, length: 1, kind: 'control', codePoint: c });
      i++;
      continue;
    }
    let len = 0, cp = 0, min = 0;
    if (c >= 0xc2 && c <= 0xdf) { len = 2; cp = c & 0x1f; min = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { len = 3; cp = c & 0x0f; min = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { len = 4; cp = c & 0x07; min = 0x10000; }
    let ok = len > 0 && i + len <= n;
    for (let k = 1; ok && k < len; k++) {
      const cc = b[i + k]!;
      if ((cc & 0xc0) !== 0x80) ok = false; else cp = (cp << 6) | (cc & 0x3f);
    }
    if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
    if (!ok) {
      out.push({ index: i, length: 1, kind: 'invalid-utf8', codePoint: c });
      i++;
      continue;
    }
    const sus = SUSPICIOUS[cp];
    if (sus) out.push({ index: i, length: len, kind: 'suspicious', codePoint: cp, name: sus[0], ascii: sus[1] });
    else if (cp >= 0x80 && cp < 0xa0) out.push({ index: i, length: len, kind: 'control', codePoint: cp });
    i += len;
  }
  return out;
}

export const exampleHelper = ex;
