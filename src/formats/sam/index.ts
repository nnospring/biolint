import type { Context, FormatDef, Line, RuleMeta, Validator } from '../../core/types.ts';
import { oneOf, show, splitWithOffsets, suggest } from '../../core/util.ts';
import { S } from './rules.ts';

// ---------------------------------------------------------------------------------------------- tables

const TAB = 9, STAR = 42, EQUALS = 61, AT = 64, COLON = 58, COMMA = 44, MINUS = 45, PLUS = 43;
const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;
/** Values above this round to infinity in single precision. */
const FLOAT_MAX = 3.4028235677973366e38;
/** htslib and BAM limit one CIGAR operation to 28 bits. */
const CIGAR_LEN_LIMIT = 268435456;

const NAME_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&*+./:;=?@^_|~-';
/** 1 = allowed in a reference name (SAM v1 §1.2.1). `*` and `=` are allowed except in first position. */
const NAME_OK = new Uint8Array(256);
for (let i = 0; i < NAME_CHARS.length; i++) NAME_OK[NAME_CHARS.charCodeAt(i)] = 1;
const RE_NAME = /^[0-9A-Za-z!#$%&+./:;?@^_|~-][0-9A-Za-z!#$%&*+./:;=?@^_|~-]*$/;

/** SEQ characters: 1 = storable in BAM, 2 = legal in SAM text only, 0 = not a base code. */
const SEQ_CLASS = new Uint8Array(256);
for (let c = 65; c <= 90; c++) { SEQ_CLASS[c] = 2; SEQ_CLASS[c + 32] = 2; }
SEQ_CLASS[46] = 2;
for (const ch of '=ACMGRSVTWYHKDBN') { SEQ_CLASS[ch.charCodeAt(0)] = 1; SEQ_CLASS[ch.toLowerCase().charCodeAt(0)] = 1; }

const OP_VALID = 1, OP_QUERY = 2, OP_REF = 4, OP_H = 8, OP_S = 16;
const CIGAR_OP = new Uint8Array(256);
CIGAR_OP[77] = OP_VALID | OP_QUERY | OP_REF;   // M
CIGAR_OP[73] = OP_VALID | OP_QUERY;            // I
CIGAR_OP[68] = OP_VALID | OP_REF;              // D
CIGAR_OP[78] = OP_VALID | OP_REF;              // N
CIGAR_OP[83] = OP_VALID | OP_QUERY | OP_S;     // S
CIGAR_OP[72] = OP_VALID | OP_H;                // H
CIGAR_OP[80] = OP_VALID;                       // P
CIGAR_OP[61] = OP_VALID | OP_QUERY | OP_REF;   // =
CIGAR_OP[88] = OP_VALID | OP_QUERY | OP_REF;   // X

/** 1 = letter, 2 = digit. */
const ALNUM = new Uint8Array(256);
for (let c = 65; c <= 90; c++) { ALNUM[c] = 1; ALNUM[c + 32] = 1; }
for (let c = 48; c <= 57; c++) ALNUM[c] = 2;

/** 1 = upper-case hex digit, 2 = lower-case hex letter. */
const HEX = new Uint8Array(256);
for (let c = 48; c <= 57; c++) HEX[c] = 1;
for (let c = 65; c <= 70; c++) { HEX[c] = 1; HEX[c + 32] = 2; }

const tagKey = (tag: string) => (tag.charCodeAt(0) << 8) | tag.charCodeAt(1);

/** Type of each predefined tag (SAMtags §1); tags the table lists with type `?` are left out. */
const PREDEFINED: Record<string, string> = {
  AM: 'i', AS: 'i', BC: 'Z', BQ: 'Z', BZ: 'Z', CB: 'Z', CC: 'Z', CG: 'B', CM: 'i', CO: 'Z', CP: 'i', CQ: 'Z', CR: 'Z', CS: 'Z', CT: 'Z', CY: 'Z',
  E2: 'Z', FI: 'i', FS: 'Z', FZ: 'B', H0: 'i', H1: 'i', H2: 'i', HI: 'i', IH: 'i', LB: 'Z', MC: 'Z', MD: 'Z', MI: 'Z', ML: 'B', MM: 'Z', MN: 'i',
  MQ: 'i', NH: 'i', NM: 'i', OA: 'Z', OC: 'Z', OP: 'i', OQ: 'Z', OX: 'Z', PG: 'Z', PQ: 'i', PT: 'Z', PU: 'Z', Q2: 'Z', QT: 'Z', QX: 'Z', R2: 'Z',
  RG: 'Z', RX: 'Z', SA: 'Z', SM: 'i', TC: 'i', TS: 'A', U2: 'Z', UQ: 'i',
};
const PREDEFINED_TYPE = new Uint8Array(65536);
for (const [tag, type] of Object.entries(PREDEFINED)) PREDEFINED_TYPE[tagKey(tag)] = type.charCodeAt(0);
const KEY_RG = tagKey('RG'), KEY_PG = tagKey('PG');

const TYPE_NAMES: Record<string, string> = { A: 'a character', i: 'an integer', f: 'a number', Z: 'a string', H: 'a hex string', B: 'a numeric array' };

/** Inclusive ranges of the B-array element types. */
const B_RANGE: Record<number, [number, number]> = {
  99: [-128, 127], 67: [0, 255], 115: [-32768, 32767], 83: [0, 65535], 105: [-2147483648, INT32_MAX], 73: [0, UINT32_MAX],
};

const RECORD_TYPES = ['@HD', '@SQ', '@RG', '@PG', '@CO'];
const KNOWN_TAGS: Record<string, string[]> = {
  '@HD': ['VN', 'SO', 'GO', 'SS'],
  '@SQ': ['SN', 'LN', 'AH', 'AN', 'AS', 'DS', 'M5', 'SP', 'TP', 'UR'],
  '@RG': ['ID', 'BC', 'CN', 'DS', 'DT', 'FO', 'KS', 'LB', 'PG', 'PI', 'PL', 'PM', 'PU', 'SM'],
  '@PG': ['ID', 'PN', 'CL', 'PP', 'DS', 'VN'],
};
/** A space followed by a predefined tag of the same record type: the sign of a tab that became a space. */
const SPACE_BEFORE_TAG: Record<string, RegExp> = Object.fromEntries(Object.entries(KNOWN_TAGS).map(([k, tags]) => [k, new RegExp(` +(?=(?:${tags.join('|')}):)`)]));
const REQUIRED: Record<string, string[]> = { '@SQ': ['SN', 'LN'], '@RG': ['ID'], '@PG': ['ID'] };

const SORT_ORDERS = ['unknown', 'unsorted', 'queryname', 'coordinate'];
const GROUP_ORDERS = ['none', 'query', 'reference'];
const RE_SUBSORT = /^(?:coordinate|queryname|unsorted)(?::[A-Za-z0-9_-]+)+$/;
const PLATFORMS = ['CAPILLARY', 'DNBSEQ', 'ELEMENT', 'HELICOS', 'ILLUMINA', 'IONTORRENT', 'LS454', 'ONT', 'PACBIO', 'SINGULAR', 'SOLID', 'ULTIMA'];
const PLATFORM_ALIASES: [RegExp, string][] = [
  [/nanopore|oxford|minion|promethion/i, 'ONT'], [/pac.?bio|smrt|sequel|revio/i, 'PACBIO'], [/ion.?torrent|proton|^ion$/i, 'IONTORRENT'],
  [/454|roche/i, 'LS454'], [/bgi|mgi|dnb/i, 'DNBSEQ'], [/solexa|illumina|novaseq|hiseq|miseq|nextseq/i, 'ILLUMINA'], [/sanger|capillary|abi ?3/i, 'CAPILLARY'],
  [/solid/i, 'SOLID'], [/element|aviti/i, 'ELEMENT'], [/ultima/i, 'ULTIMA'], [/singular/i, 'SINGULAR'], [/helicos/i, 'HELICOS'],
];

const FLAG_BITS: [number, string][] = [
  [0x1, 'paired'], [0x2, 'proper pair'], [0x4, 'unmapped'], [0x8, 'mate unmapped'], [0x10, 'reverse strand'], [0x20, 'mate reverse strand'],
  [0x40, 'first in template'], [0x80, 'last in template'], [0x100, 'secondary'], [0x200, 'QC fail'], [0x400, 'duplicate'], [0x800, 'supplementary'],
];
const hex = (n: number) => '0x' + n.toString(16);
/** `0x2 proper pair + 0x40 first in template`, for the bits of `flag` selected by `mask`. */
function flagBits(flag: number, mask = 0xffff): string {
  const parts: string[] = [];
  for (const [bit, name] of FLAG_BITS) if (flag & mask & bit) parts.push(`${hex(bit)} ${name}`);
  for (let bit = 0x1000; bit <= 0x8000; bit <<= 1) if (flag & mask & bit) parts.push(`${hex(bit)} (reserved)`);
  return parts.join(' + ');
}

const FIELD_NAMES = ['QNAME', 'FLAG', 'RNAME', 'POS', 'MAPQ', 'CIGAR', 'RNEXT', 'PNEXT', 'TLEN', 'SEQ', 'QUAL'];
const PLACEHOLDER = ['*', '0', '*', '0', '0', '*', '*', '0', '0', '*', '*'];

// ---------------------------------------------------------------------------------------------- helpers

/** Canonical non-negative decimal (no sign, no leading zero) or -1. */
function parseUInt(b: Uint8Array, s: number, e: number): number {
  const n = e - s;
  if (n <= 0 || n > 15) return -1;
  let c = b[s]! - 48;
  if (c < 0 || c > 9 || (c === 0 && n > 1)) return -1;
  let v = c;
  for (let i = s + 1; i < e; i++) {
    c = b[i]! - 48;
    if (c < 0 || c > 9) return -1;
    v = v * 10 + c;
  }
  return v;
}

/** The float pattern of SAM v1 §1.5: `[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?`. Returns 0 = no match, 1 = match, 2 = match with exponent. */
function specFloat(b: Uint8Array, s: number, e: number): number {
  let i = s;
  if (i < e && (b[i] === PLUS || b[i] === MINUS)) i++;
  const d0 = i;
  while (i < e && b[i]! >= 48 && b[i]! <= 57) i++;
  const intDigits = i - d0;
  if (i < e && b[i] === 46) {
    const f0 = ++i;
    while (i < e && b[i]! >= 48 && b[i]! <= 57) i++;
    if (i === f0) return 0;
  } else if (intDigits === 0) return 0;
  let kind = intDigits > 38 ? 2 : 1;
  if (i < e && (b[i] === 101 || b[i] === 69)) {
    i++;
    if (i < e && (b[i] === PLUS || b[i] === MINUS)) i++;
    const x0 = i;
    while (i < e && b[i]! >= 48 && b[i]! <= 57) i++;
    if (i === x0) return 0;
    kind = 2;
  }
  return i === e ? kind : 0;
}

/** For text that failed `specFloat`: true when C's strtod still reads all of it (`5.`, `nan`, `inf`, hex floats), as htslib does. */
function looseFloat(text: string): boolean {
  return /^[-+]?(?:inf(?:inity)?|nan)$/i.test(text) || /^[-+]?[0-9]+\.(?:[eE][-+]?[0-9]+)?$/.test(text) || /^[-+]?0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][-+]?[0-9]+)?$/.test(text);
}

function ascii(b: Uint8Array, s: number, e: number): string {
  let r = '';
  for (let i = s; i < e; i++) r += String.fromCharCode(b[i]!);
  return r;
}

function sameBytes(b: Uint8Array, s: number, e: number, buf: Uint8Array, len: number): boolean {
  if (e - s !== len) return false;
  for (let i = 0; i < len; i++) if (b[s + i] !== buf[i]) return false;
  return true;
}

/** Byte-wise comparison, the order Picard's queryname sort uses for ASCII names. */
function lexCompare(a: Uint8Array, an: number, b: Uint8Array, bs: number, be: number): number {
  const bn = be - bs;
  const n = an < bn ? an : bn;
  for (let i = 0; i < n; i++) { const d = a[i]! - b[bs + i]!; if (d) return d; }
  return an - bn;
}

const isDigit = (c: number) => c >= 48 && c <= 57;
/** Natural comparison: runs of digits compare as numbers (as `samtools sort -n` does). Numbers that differ only in leading zeros tie. */
function naturalCompare(a: Uint8Array, an: number, b: Uint8Array, bs: number, be: number): number {
  let i = 0, j = bs;
  while (i < an && j < be) {
    const ca = a[i]!, cb = b[j]!;
    if (isDigit(ca) && isDigit(cb)) {
      while (i < an && a[i] === 48) i++;
      while (j < be && b[j] === 48) j++;
      let ie = i, je = j;
      while (ie < an && isDigit(a[ie]!)) ie++;
      while (je < be && isDigit(b[je]!)) je++;
      if (ie - i !== je - j) return (ie - i) - (je - j);
      for (; i < ie; i++, j++) { const d = a[i]! - b[j]!; if (d) return d; }
    } else {
      if (ca !== cb) return ca - cb;
      i++; j++;
    }
  }
  return (an - i) - (be - j);
}

/** ISO 8601 calendar, ordinal or week date, optionally followed by a time and a zone. */
function isIso8601(value: string): boolean {
  const m = /^(\d{4})(?:-?(\d{2})(?:-?(\d{2}))?|-?(\d{3})|-?W(\d{2})(?:-?(\d))?)?(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,]\d+)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(value);
  if (!m) return false;
  const [, , month, day, ordinal, week, weekday, hour, minute, second] = m;
  if (month !== undefined && (+month < 1 || +month > 12)) return false;
  if (day !== undefined && (+day < 1 || +day > 31)) return false;
  if (ordinal !== undefined && (+ordinal < 1 || +ordinal > 366)) return false;
  if (week !== undefined && (+week < 1 || +week > 53)) return false;
  if (weekday !== undefined && (+weekday < 1 || +weekday > 7)) return false;
  if (hour !== undefined && +hour > 24) return false;
  if (minute !== undefined && +minute > 59) return false;
  if (second !== undefined && +second > 60) return false;
  // `YYYYMM` is not a valid basic-format date (it would be ambiguous with YYMMDD).
  if (/^\d{6}$/.test(value)) return false;
  return true;
}

function nameProblem(name: string): { at: number; what: string } | null {
  if (name[0] === '*' || name[0] === '=') return { at: 0, what: `starts with \`${name[0]}\`` };
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!NAME_OK[c]) return { at: i, what: c === 32 ? 'contains a space' : c > 126 ? 'contains a non-ASCII character' : `contains \`${show(name[i]!)}\`` };
  }
  return null;
}

function nameHint(name: string): string {
  if (name.includes(' ')) return `use the part before the first space (\`${show(name.slice(0, name.indexOf(' ')))}\`): aligners take the reference name from the FASTA header up to the first whitespace`;
  return 'rename the sequence in the reference FASTA and realign, or rename it here and in every record with `samtools reheader`';
}

interface HeaderField { value: string; col: number; end: number; glued?: boolean }
/** A value that seems to contain the next field: `ID:rg1 SM:x` where a tab became a space. */
interface Glue { col: number; end: number; first: string; next: string; tags: string[] }

const REF_STAR = -1, REF_UNKNOWN = -2, REF_NO_HEADER = -3, REF_INVALID = -4;
const RG_OK = 0, RG_UNDECLARED = 1, RG_NO_HEADER = 2;

// ---------------------------------------------------------------------------------------------- validator

class SamValidator implements Validator {
  private headerLines = 0;
  private blankRun = 0;
  private blankStart = 0;
  private hdSeen = false;
  private sawAlignment = false;
  private records = 0;
  private version = '';
  private sortOrder = '';

  // Reference dictionary: needed to resolve every RNAME, so it is kept for the whole file.
  // Per reference: one Map entry plus three array slots.
  private readonly sq = new Map<string, number>();
  private readonly sqLength: number[] = [];
  private readonly sqLine: number[] = [];
  private readonly sqCircular: boolean[] = [];
  /** Alternative names (`@SQ AN`) with the header line that lists them: kept because they must differ from every SN. */
  private readonly altNames = new Map<string, number>();
  /** Reference index each alternative name stands for (htslib resolves an RNAME through it). */
  private readonly altRef = new Map<string, number>();
  /** Read group and program IDs: kept because they must be unique and records refer to them. */
  private readonly readGroups = new Map<string, number>();
  private readonly programs = new Map<string, number>();
  private pendingPrevious: { id: string; previous: string; line: number }[] = [];

  // Per-record scratch and caches (fixed size).
  private readonly tabs = new Int32Array(11);
  private readonly seenTag = new Uint32Array(65536);
  private rnameBuf = new Uint8Array(64);
  private rnameLen = -1;
  private rnameRef = REF_STAR;
  private rnameHint = '';
  private rnameAlias = false;
  private rnextBuf = new Uint8Array(64);
  private rnextLen = -1;
  private rnextRef = REF_STAR;
  private rnextHint = '';
  private rnextAlias = false;
  private rgBuf = new Uint8Array(64);
  private rgLen = -1;
  private rgState = RG_OK;
  private rgHint = '';
  private pgBuf = new Uint8Array(64);
  private pgLen = -1;
  private pgState = RG_OK;
  private noSqReported = false;
  private rgHeaderReported = false;

  // Sort-order tracking: only the previous record's key.
  private sortReported = false;
  private prevRef = 0;
  private prevPos = 0;
  private prevRefName = '';
  private lexSorted = true;
  private naturalSorted = true;
  private qnameBuf = new Uint8Array(256);
  private qnameLen = -1;

  line(l: Line, ctx: Context): void {
    const b = l.bytes;
    if (b.length === 0) {
      // Held back until we know whether content follows: blank lines at the end get one diagnostic with a fix.
      if (this.blankRun++ === 0) this.blankStart = l.no;
      return;
    }
    if (this.blankRun > 0) this.flushBlank(ctx, false);
    if (b[0] === AT) {
      if (!this.sawAlignment) { this.header(l.text, l.no, ctx); return; }
      if (this.looksLikeHeader(b)) {
        const text = l.text;
        const type = text.slice(0, 3);
        ctx.report(S.headerAfterAlignment, 0, Math.min(text.length, 3), `\`${type}\` header line after the alignments have started`, {
          hint: 'move every header line above the first alignment; to join files use `samtools merge` or `samtools cat`, not `cat`',
        });
        return;
      }
    }
    this.alignment(l, ctx);
  }

  end(ctx: Context): void {
    if (this.blankRun > 0) this.flushBlank(ctx, true);
    if (!this.sawAlignment) this.finishHeader(ctx);
    if (this.headerLines > 0 && !this.sawAlignment) {
      ctx.reportAt(S.noAlignments, 0, 'the file has a header but no alignment records', { hint: 'fine for a header-only file; otherwise check that the aligner finished and wrote its output' });
    }
    ctx.stat('version', this.version ? `SAM ${this.version}` : 'SAM');
    ctx.stat('records', this.records);
  }

  private flushBlank(ctx: Context, atEnd: boolean): void {
    const k = this.blankRun;
    this.blankRun = 0;
    if (atEnd) {
      ctx.reportAt(S.blankLine, this.blankStart, k === 1 ? 'blank line at the end of the file' : `${k} blank lines at the end of the file`, {
        hint: 'delete the empty line' + (k === 1 ? '' : 's') + ': samtools reads a blank line as a malformed alignment and stops',
        fix: { title: 'Remove trailing blank lines', transform: 'trim-trailing-blank-lines' },
      });
      return;
    }
    const where = this.sawAlignment ? 'among the alignments' : this.headerLines > 0 ? 'in the header' : 'at the start of the file';
    for (let i = 0; i < k; i++) {
      ctx.reportAt(S.blankLine, this.blankStart + i, `blank line ${where}`, { hint: 'delete the empty line: samtools reads it as a malformed alignment and stops' });
    }
  }

  /** After the first alignment, an `@` line is a header line only if it has a record type and does not parse as an alignment. */
  private looksLikeHeader(b: Uint8Array): boolean {
    const n = b.length;
    if (n < 3 || (n > 3 && b[3] !== TAB)) return false;
    const type = String.fromCharCode(b[0]!, b[1]!, b[2]!);
    if (!RECORD_TYPES.includes(type)) return false;
    if (n === 3) return true;
    // `@SQ<tab>16<tab>...` with eleven fields is an alignment with an unfortunate read name.
    const t1 = b.indexOf(TAB, 4);
    if (t1 < 0 || parseUInt(b, 4, t1) < 0) return true;
    let tabs = 2;
    for (let p = b.indexOf(TAB, t1 + 1); p >= 0 && tabs < 10; p = b.indexOf(TAB, p + 1)) tabs++;
    return tabs < 10;
  }

  // ------------------------------------------------------------------ header

  private header(text: string, lineNo: number, ctx: Context): void {
    this.headerLines++;
    const firstTab = text.indexOf('\t');
    const type = firstTab < 0 ? text : text.slice(0, firstTab);

    if (!RECORD_TYPES.includes(type)) {
      const spaced = /^@(?:HD|SQ|RG|PG|CO) /.exec(text);
      if (spaced) {
        ctx.report(S.headerSpaces, 3, 3 + /^ +/.exec(text.slice(3))![0].length, `\`${text.slice(0, 3)}\` is followed by a space instead of a tab`, {
          hint: 'separate header fields with tab characters; if an editor converted them, switch off "expand tabs" and restore the file',
        });
        return;
      }
      let hint = `header lines start with ${oneOf(RECORD_TYPES)}`;
      const upper = type.toUpperCase();
      const fields = text.split('\t');
      if (fields.length >= 11 && /^\d+$/.test(fields[1]!)) hint = 'this looks like an alignment whose read name starts with `@` (a FASTQ header): remove the `@`, or the line is taken for a header line';
      else if (type !== upper && RECORD_TYPES.includes(upper)) hint = `record types are upper case: write \`${upper}\``;
      else if (type === '@') hint = 'delete the line, or write a comment as `@CO`, a tab and the text';
      else {
        const near = suggest(type, RECORD_TYPES);
        if (near) hint = `did you mean \`${near}\`?`;
        else if (/^@[A-Za-z]{2}$/.test(type)) hint = 'new record types cannot be added; put free text in a `@CO` line, or add your own lower-case tag to an existing line';
      }
      ctx.report(S.headerTypeUnknown, 0, Math.max(1, type.length), `\`${show(type, 24)}\` is not a header record type`, { hint });
      return;
    }

    if (type === '@HD') {
      if (this.hdSeen) {
        ctx.report(S.hdNotFirst, 0, 3, 'a second `@HD` line', { hint: 'keep one `@HD` line, as the first line of the file' });
      } else if (lineNo !== 1) {
        ctx.report(S.hdNotFirst, 0, 3, `\`@HD\` is on line ${lineNo}; it must be the first line of the file`, { hint: 'move it to the top' });
      }
    }
    if (type === '@CO') {
      if (firstTab < 0) ctx.report(S.headerFieldIrregular, 0, 3, '`@CO` is not followed by a tab', { hint: 'write `@CO`, a tab, then the comment text (which may be empty)' });
      return;
    }
    if (firstTab < 0) {
      ctx.report(S.headerFieldMalformed, 0, 3, `\`${type}\` line has no fields`, { hint: type === '@HD' ? 'write at least `@HD`, a tab and `VN:1.6`' : `add the required ${oneOf(REQUIRED[type]!.map((t) => `\`${t}:\``))} field${REQUIRED[type]!.length > 1 ? 's' : ''} after a tab, or delete the line` });
      if (type === '@HD') this.hdSeen = true;
      return;
    }

    // Split into TAG:VALUE fields.
    const { fields, starts } = splitWithOffsets(text, '\t');
    const tags = new Map<string, HeaderField>();
    const spaceRe = SPACE_BEFORE_TAG[type]!;
    let malformed = false;
    const glues: Glue[] = [];
    for (let i = 1; i < fields.length; i++) {
      const f = fields[i]!;
      const st = starts[i]!;
      if (f === '') {
        malformed = true;
        ctx.report(S.headerFieldMalformed, st - 1, st, i === fields.length - 1 ? 'the line ends with a tab, which leaves an empty field' : 'empty field between two tabs', { hint: 'remove the extra tab' });
        continue;
      }
      if (f.length < 3 || f[2] !== ':') {
        malformed = true;
        const eq = /^[A-Za-z][A-Za-z0-9]=/.test(f);
        const colon = f.indexOf(':');
        ctx.report(S.headerFieldMalformed, st, st + f.length, `\`${show(f)}\` is not a \`TAG:VALUE\` field`, {
          hint: eq ? `use a colon: \`${show(f.slice(0, 2))}:${show(f.slice(3), 30)}\`` : colon > 2 ? 'a tag is exactly two characters, followed by a colon' : colon < 0 && / /.test(text) ? 'every field is a two-character tag, a colon and a value; if this is part of the previous value, a tab has crept into it' : 'every field is a two-character tag, a colon and a value',
        });
        continue;
      }
      const tag = f.slice(0, 2);
      let value = f.slice(3);
      let end = st + f.length;
      if (!(ALNUM[f.charCodeAt(0)] === 1 && ALNUM[f.charCodeAt(1)]! > 0)) {
        ctx.report(S.headerFieldIrregular, st, st + 2, `header tag \`${show(tag)}\` is not a letter followed by a letter or digit`, { hint: 'predefined tags are two upper-case letters; use lower case for your own' });
      } else if (value === '') {
        ctx.report(S.headerFieldIrregular, st, end, `\`${tag}:\` has an empty value`, { hint: 'give it a value or delete the field' });
      } else if (tag !== 'DS' && tag !== 'CL' && /[\x80-\xff]/.test(value)) {
        const at = value.search(/[\x80-\xff]/);
        ctx.report(S.headerFieldIrregular, st + 3 + at, end, `\`${tag}\` value \`${show(value)}\` contains non-ASCII characters`, { hint: 'only `DS`, `CL` and `@CO` text may contain UTF-8; use plain ASCII here' });
      }
      // A tab that became a space glues the next field onto this value.
      let glued = false;
      if (tag !== 'DS' && tag !== 'CL' && value.includes(' ')) {
        const parts = value.split(spaceRe);
        if (parts.length > 1) {
          const at = value.search(spaceRe);
          glued = true;
          glues.push({ col: st + 3 + at, end: st + 3 + at + /^ +/.exec(value.slice(at))![0].length, first: `${tag}:${parts[0]}`, next: parts[1]!, tags: parts.slice(1).map((x) => x.slice(0, 2)) });
        }
      }
      const prev = tags.get(tag);
      if (prev && type === '@SQ' && tag === 'LN' && prev.value !== value) {
        ctx.report(S.sqLengthInvalid, st, end, `\`LN\` is given twice with different values (${show(prev.value, 20)} and ${show(value, 20)})`, { hint: 'keep the true length of the sequence; samtools refuses a header with two different lengths' });
        continue;
      }
      if (prev) {
        ctx.report(S.headerTagDuplicate, st, st + 2, `\`${tag}\` appears twice in this \`${type}\` line (\`${show(prev.value, 20)}\` and \`${show(value, 20)}\`)`, { hint: 'keep one of them' });
        continue;
      }
      tags.set(tag, glued ? { value, col: st + 3, end, glued } : { value, col: st + 3, end });
    }

    // A glued field is an error when it hides a required tag (samtools then refuses the header), otherwise a warning.
    let hidden = false;
    for (const g of glues) {
      const missing = (REQUIRED[type] ?? []).find((r) => !tags.has(r) && g.tags.includes(r));
      if (missing) {
        hidden = true;
        ctx.report(S.headerSpaces, g.col, g.end, `a space separates \`${show(g.first, 24)}\` from \`${show(g.next, 24)}\`, so the required \`${missing}\` field is not found`, {
          hint: 'separate header fields with tab characters; on a command line write the tab as `\\t` inside quotes',
        });
      } else {
        ctx.report(S.headerValueGlued, g.col, g.end, `the value \`${show(g.first + ' ' + g.next, 40)}\` looks like two fields separated by a space instead of a tab`, {
          hint: `tools read the whole text as the value of \`${g.first.slice(0, 2)}\`; if \`${show(g.next.slice(0, 2))}\` was meant as its own field, put a tab before it`,
        });
      }
    }

    if (!malformed && !hidden) {
      for (const required of REQUIRED[type] ?? []) {
        if (tags.has(required)) continue;
        const wrongCase = [...tags.keys()].find((t) => t.toUpperCase() === required);
        ctx.report(S.headerRequiredMissing, 0, 3, `\`${type}\` line has no \`${required}\``, {
          hint: wrongCase ? `tags are case-sensitive: write \`${required}:\` instead of \`${wrongCase}:\`` : required === 'LN' ? 'add `LN:<length in bases>`; `samtools dict ref.fa` writes correct @SQ lines' : `add \`${required}:<value>\``,
        });
      }
    }

    if (type === '@HD') this.headerHd(tags, ctx);
    else if (type === '@SQ') this.headerSq(tags, lineNo, ctx);
    else if (type === '@RG') this.headerRg(tags, lineNo, ctx);
    else this.headerPg(tags, lineNo, ctx);
  }

  private headerHd(tags: Map<string, HeaderField>, ctx: Context): void {
    const first = !this.hdSeen;
    this.hdSeen = true;
    const vn = tags.get('VN');
    if (!vn) {
      ctx.report(S.hdVersionInvalid, 0, 3, '`@HD` has no `VN` (format version)', { hint: 'add `VN:1.6`' });
    } else if (!/^[0-9]+\.[0-9]+$/.test(vn.value)) {
      const digits = /^[0-9]+$/.test(vn.value);
      ctx.report(S.hdVersionInvalid, vn.col, vn.end, `\`VN:${show(vn.value)}\` is not a version of the form major.minor`, { hint: digits ? `write \`VN:${vn.value}.0\`` : 'write the SAM version the file follows, e.g. `VN:1.6`' });
    } else if (first) this.version = vn.value;

    const so = tags.get('SO');
    if (so) {
      if (SORT_ORDERS.includes(so.value)) { if (first) this.sortOrder = so.value; }
      else {
        const v = so.value.toLowerCase();
        const guess = SORT_ORDERS.includes(v) ? v : /coord|pos|^sorted$/.test(v) ? 'coordinate' : /query|name/.test(v) ? 'queryname' : /^(un|not|none)/.test(v) ? 'unsorted' : suggest(so.value, SORT_ORDERS);
        ctx.report(S.hdSortOrderInvalid, so.col, so.end, `\`SO:${show(so.value)}\` is not a sort order`, { hint: guess ? `did you mean \`SO:${guess}\`? the value is one of ${oneOf(SORT_ORDERS)}` : `use one of ${oneOf(SORT_ORDERS)}` });
      }
    }
    const go = tags.get('GO');
    if (go && !GROUP_ORDERS.includes(go.value)) {
      const v = go.value.toLowerCase();
      const guess = GROUP_ORDERS.includes(v) ? v : /query|name/.test(v) ? 'query' : /ref|coord|pos/.test(v) ? 'reference' : suggest(go.value, GROUP_ORDERS);
      ctx.report(S.hdSortOrderInvalid, go.col, go.end, `\`GO:${show(go.value)}\` is not a grouping`, { hint: guess ? `did you mean \`GO:${guess}\`? the value is one of ${oneOf(GROUP_ORDERS)}` : `use one of ${oneOf(GROUP_ORDERS)}` });
    }
    const ss = tags.get('SS');
    // A declared sub-sort narrows which of the two queryname orders is expected.
    if (ss && first && so?.value === 'queryname') {
      if (/^queryname:natural(?::|$)/.test(ss.value)) this.lexSorted = false;
      else if (/^queryname:lexicographical(?::|$)/.test(ss.value)) this.naturalSorted = false;
    }
    if (ss && !RE_SUBSORT.test(ss.value)) {
      ctx.report(S.hdSortOrderInvalid, ss.col, ss.end, `\`SS:${show(ss.value)}\` is not a sub-sort order`, {
        hint: 'the form is the `SO` value (`coordinate`, `queryname` or `unsorted`), then one or more `:term` parts made of letters, digits, `_` and `-`, e.g. `SS:coordinate:queryname`',
      });
    }
  }

  private headerSq(tags: Map<string, HeaderField>, lineNo: number, ctx: Context): void {
    const sn = tags.get('SN');
    const ln = tags.get('LN');
    let length = -1;
    if (ln) {
      const v = ln.value;
      if (/^[0-9]+$/.test(v) && Number(v) > 0) {
        length = Number(v);
        if (length > INT32_MAX) ctx.report(S.sqLengthTooLarge, ln.col, ln.end, `reference length ${show(v, 24)} is larger than 2147483647 (2^31-1)`, { hint: 'check the value; a reference this long cannot be stored in BAM' });
      } else if (v !== '') {
        const digits = v.replace(/[,_ .']/g, '');
        let hint = 'LN is the sequence length in bases, digits only';
        if (/^\d{1,3}(?:[,_ .']\d{3})+$/.test(v)) hint = `write it without separators: \`LN:${digits}\``;
        else if (/^\d+(?:\.\d+)?[eE]\+?\d+$/.test(v)) hint = `scientific notation is usually a spreadsheet artefact; write the integer, e.g. \`LN:${Number(v).toFixed(0)}\``;
        else if (/^0+$/.test(v)) hint = 'a reference has at least one base; delete the @SQ line if the sequence is empty';
        else if (/^-/.test(v)) hint = 'a length cannot be negative';
        ctx.report(S.sqLengthInvalid, ln.col, ln.end, `reference length \`${show(v)}\` is not a positive integer`, { hint });
      }
    }
    if (sn && sn.value !== '') {
      const name = sn.value;
      const problem = nameProblem(name);
      if (problem && !sn.glued) ctx.report(S.sqNameInvalid, sn.col + problem.at, problem.at === 0 && problem.what.startsWith('starts') ? sn.col + 1 : sn.col + problem.at + 1, `reference name \`${show(name)}\` ${problem.what}`, { hint: nameHint(name) });
      const prev = this.sq.get(name);
      if (prev !== undefined) {
        ctx.report(S.sqNameDuplicate, sn.col, sn.end, `reference \`${show(name)}\` is already defined`, {
          hint: 'delete the repeated @SQ line; if two headers were joined with `cat`, use `samtools merge` instead',
          notes: [`first defined on line ${this.sqLine[prev]}`],
        });
      } else {
        const alias = this.altNames.get(name);
        if (alias !== undefined) {
          ctx.report(S.sqAltNameInvalid, sn.col, sn.end, `reference name \`${show(name)}\` is also an alternative name (\`AN\`) of another reference`, { notes: [`listed as AN on line ${alias}`], hint: 'remove it from that AN list' });
        }
        this.sq.set(name, this.sqLength.length);
        this.sqLength.push(length);
        this.sqLine.push(lineNo);
        this.sqCircular.push(tags.get('TP')?.value === 'circular');
      }
    }

    const an = tags.get('AN');
    if (an && an.value !== '') {
      let off = an.col;
      for (const alt of an.value.split(',')) {
        const end = off + alt.length;
        if (alt === '') ctx.report(S.sqAltNameInvalid, Math.max(an.col, off - 1), Math.max(an.col + 1, off), 'empty name in the `AN` list (stray comma)', { hint: 'remove the extra comma' });
        else if (!RE_NAME.test(alt)) {
          const p = nameProblem(alt)!;
          ctx.report(S.sqAltNameInvalid, off, end, `alternative name \`${show(alt)}\` ${p.what}`, { hint: 'alternative names follow the same rules as `SN`; separate several with commas' });
        } else if (this.sq.has(alt)) {
          ctx.report(S.sqAltNameInvalid, off, end, `alternative name \`${show(alt)}\` is the \`SN\` of ${alt === sn?.value ? 'this same line' : 'a reference'}`, { hint: 'an alias must differ from every reference name', notes: [`@SQ SN:${show(alt)} is on line ${this.sqLine[this.sq.get(alt)!]}`] });
        } else if (this.altNames.has(alt)) {
          ctx.report(S.sqAltNameInvalid, off, end, `alternative name \`${show(alt)}\` is listed twice`, { hint: 'each alias may name one reference only', notes: [`first listed on line ${this.altNames.get(alt)}`] });
        } else {
          this.altNames.set(alt, lineNo);
          const own = sn ? this.sq.get(sn.value) : undefined;
          if (own !== undefined && this.sqLine[own] === lineNo) this.altRef.set(alt, own);
        }
        off = end + 1;
      }
    }

    const m5 = tags.get('M5');
    if (m5 && m5.value !== '' && !/^[0-9a-f]{32}$/.test(m5.value)) {
      const v = m5.value;
      const hint = /^[0-9a-fA-F]{32}$/.test(v) ? `write it in lower case: \`M5:${v.toLowerCase()}\`` : /^[0-9a-fA-F]+$/.test(v) ? `an MD5 digest has 32 hexadecimal digits; this has ${v.length}` : 'M5 is the MD5 digest of the upper-cased sequence, as 32 lower-case hexadecimal digits (`samtools dict` computes it)';
      ctx.report(S.headerValueInvalid, m5.col, m5.end, `\`M5:${show(v)}\` is not an MD5 digest in lower-case hexadecimal`, { hint, spec: 'SAM v1 §1.3.2' });
    }
    const tp = tags.get('TP');
    if (tp && tp.value !== '' && tp.value !== 'linear' && tp.value !== 'circular') {
      const guess = suggest(tp.value, ['linear', 'circular']);
      ctx.report(S.headerValueInvalid, tp.col, tp.end, `\`TP:${show(tp.value)}\` is not a molecule topology`, { hint: guess ? `did you mean \`TP:${guess}\`?` : 'use `linear` or `circular`, or leave the tag out (linear is the default)' });
    }
    const ah = tags.get('AH');
    if (ah && ah.value !== '' && ah.value !== '*' && !RE_NAME.test(ah.value)) {
      ctx.report(S.headerValueInvalid, ah.col, ah.end, `\`AH:${show(ah.value)}\` is not a locus`, { hint: 'write the primary-assembly locus as `chr:start-end` or `chr`, or `*` if it is unknown' });
    }
  }

  private headerRg(tags: Map<string, HeaderField>, lineNo: number, ctx: Context): void {
    const id = tags.get('ID');
    if (id && id.value !== '') {
      const prev = this.readGroups.get(id.value);
      if (prev !== undefined) {
        ctx.report(S.rgIdDuplicate, id.col, id.end, `read group \`${show(id.value)}\` is already defined`, {
          hint: 'give each @RG line its own ID and update the `RG:Z:` tags of its reads (`samtools addreplacerg`), or delete the repeated line',
          notes: [`first defined on line ${prev}`],
        });
      } else this.readGroups.set(id.value, lineNo);
    }
    const pl = tags.get('PL');
    if (pl && pl.value !== '' && !PLATFORMS.includes(pl.value)) {
      const v = pl.value;
      const upper = v.toUpperCase();
      if (PLATFORMS.includes(upper)) {
        ctx.report(S.rgPlatformCase, pl.col, pl.end, `\`PL:${show(v)}\` is not in upper case`, { hint: `write \`PL:${upper}\`` });
      } else {
        const alias = PLATFORM_ALIASES.find(([re]) => re.test(v))?.[1] ?? suggest(v, PLATFORMS);
        ctx.report(S.rgPlatformInvalid, pl.col, pl.end, `\`PL:${show(v)}\` is not a platform name`, {
          hint: alias ? `did you mean \`PL:${alias}\`? put the instrument model in \`PM\`` : 'leave `PL` out when the technology is not in the list or is unknown, and describe the instrument in `PM`',
        });
      }
    }
    const dt = tags.get('DT');
    if (dt && dt.value !== '' && !isIso8601(dt.value.trim())) {
      ctx.report(S.headerValueInvalid, dt.col, dt.end, `\`DT:${show(dt.value)}\` is not an ISO 8601 date`, { hint: 'write the run date as `YYYY-MM-DD` or `YYYY-MM-DDThh:mm:ss+hh:mm`' });
    }
    const pi = tags.get('PI');
    if (pi && pi.value !== '' && !/^[0-9]+$/.test(pi.value)) {
      ctx.report(S.headerValueInvalid, pi.col, pi.end, `\`PI:${show(pi.value)}\` is not a whole number`, { hint: 'PI is the predicted median insert size rounded to the nearest integer' });
    }
    const fo = tags.get('FO');
    if (fo && fo.value !== '' && !/^(?:\*|[ACMGRSVTWYHKDBN]+)$/.test(fo.value)) {
      ctx.report(S.headerValueInvalid, fo.col, fo.end, `\`FO:${show(fo.value)}\` is not a flow order`, { hint: 'write the flow order in upper-case IUPAC codes, or `*`' });
    }
  }

  private headerPg(tags: Map<string, HeaderField>, lineNo: number, ctx: Context): void {
    const id = tags.get('ID');
    if (id && id.value !== '') {
      const prev = this.programs.get(id.value);
      if (prev !== undefined) {
        ctx.report(S.pgIdDuplicate, id.col, id.end, `program ID \`${show(id.value)}\` is already defined`, { hint: `give this step its own ID, e.g. \`ID:${show(id.value, 30)}.1\``, notes: [`first defined on line ${prev}`] });
      } else this.programs.set(id.value, lineNo);
    }
    const pp = tags.get('PP');
    if (pp && pp.value !== '') {
      if (id && pp.value === id.value) {
        ctx.report(S.pgPreviousUnknown, pp.col, pp.end, `\`PP:${show(pp.value)}\` points at its own @PG line`, { hint: 'PP names the program that ran before this one; delete it on the first step of the chain' });
      } else if (!this.programs.has(pp.value)) {
        // May be defined further down: decided when the header ends.
        this.pendingPrevious.push({ id: id?.value ?? '', previous: pp.value, line: lineNo });
      }
    }
  }

  private finishHeader(ctx: Context): void {
    for (const p of this.pendingPrevious) {
      if (this.programs.has(p.previous)) continue;
      const near = suggest(p.previous, [...this.programs.keys()].filter((k) => k !== p.id).slice(0, 200));
      ctx.reportAt(S.pgPreviousUnknown, p.line, `\`PP:${show(p.previous)}\` does not match the ID of any @PG line`, {
        hint: near ? `did you mean \`PP:${near}\`?` : 'add the @PG line of the earlier program, or delete this `PP` field',
      });
    }
    this.pendingPrevious = [];
  }

  // ------------------------------------------------------------------ alignment lines

  private alignment(l: Line, ctx: Context): void {
    const b = l.bytes;
    const n = b.length;
    if (!this.sawAlignment) { this.sawAlignment = true; this.finishHeader(ctx); }

    // Locate the tabs that end the first eleven fields.
    const t = this.tabs;
    let nt = 0;
    for (let p = b.indexOf(TAB); p >= 0; p = b.indexOf(TAB, p + 1)) { t[nt++] = p; if (nt === 11) break; }
    if (nt < 10) { this.tooFewFields(l, nt + 1, ctx); return; }
    this.records++;
    const record = this.records;
    const t0 = t[0]!, t1 = t[1]!, t2 = t[2]!, t3 = t[3]!, t4 = t[4]!, t5 = t[5]!, t6 = t[6]!, t7 = t[7]!, t8 = t[8]!, t9 = t[9]!;
    const qualEnd = nt === 11 ? t[10]! : n;

    // 1 QNAME
    if (t0 === 0) this.emptyField(0, 0, ctx);
    else if (t0 > 254) {
      ctx.report(S.qnameTooLong, 254, t0, `read name is ${t0} characters long; the limit is 254`, { hint: 'shorten the read names before aligning, e.g. drop the FASTQ comment or replace long names with a counter' });
    } else {
      for (let i = 0; i < t0; i++) {
        const c = b[i]!;
        if (c < 33 || c > 126 || c === AT) { this.badQname(l, i, t0, ctx); break; }
      }
    }

    // 2 FLAG
    let flag = parseUInt(b, t0 + 1, t1);
    if (flag < 0 || flag > 65535) { this.badFlag(l, t0 + 1, t1, ctx); flag = -1; }
    else if (flag & 0xf000) this.flagProblem(flag, 3, t0 + 1, t1, ctx);
    else if ((flag & 0x1) === 0 && (flag & 0xea) !== 0) this.flagProblem(flag, 1, t0 + 1, t1, ctx);
    else if ((flag & 0x4) !== 0 && (flag & 0x902) !== 0) this.flagProblem(flag, 2, t0 + 1, t1, ctx);

    // 3 RNAME
    let ref: number;
    const rs = t1 + 1;
    if (t2 === rs) { this.emptyField(2, rs, ctx); ref = REF_INVALID; }
    else if (t2 - rs === 1 && b[rs] === STAR) ref = REF_STAR;
    else {
      if (!sameBytes(b, rs, t2, this.rnameBuf, this.rnameLen)) {
        const len = t2 - rs;
        if (len > this.rnameBuf.length) this.rnameBuf = new Uint8Array(len * 2);
        this.rnameBuf.set(b.subarray(rs, t2));
        this.rnameLen = len;
        this.rnameRef = this.resolveReference(ascii(b, rs, t2), 'RNAME', rs, ctx);
        this.rnameHint = this.lastHint;
        this.rnameAlias = this.rnameRef >= 0 && this.lastHint !== '';
      } else if (this.rnameRef === REF_UNKNOWN) this.unknownReference(ascii(b, rs, t2), 'RNAME', rs, this.rnameHint, ctx);
      else if (this.rnameAlias) this.aliasUsed(ascii(b, rs, t2), 'RNAME', rs, this.rnameHint, ctx);
      ref = this.rnameRef;
    }

    // 4 POS
    let pos = parseUInt(b, t2 + 1, t3);
    if (pos < 0) pos = this.slowInt(l, 3, t2 + 1, t3, S.posInvalid, ctx);
    if (pos > INT32_MAX) ctx.report(S.coordinateRange, t2 + 1, t3, `POS ${pos} is larger than 2147483647 (2^31-1)`, { hint: 'no reference allowed by the specification is this long: the column may hold something other than a position' });

    // 5 MAPQ
    let mapq = parseUInt(b, t3 + 1, t4);
    if (mapq < 0) mapq = this.slowInt(l, 4, t3 + 1, t4, S.mapqInvalid, ctx);
    if (mapq > 255) ctx.report(S.mapqInvalid, t3 + 1, t4, `MAPQ ${mapq} is larger than 255`, { hint: 'mapping quality is capped at 254; 255 means "not available"' });

    // 6 CIGAR
    const cs = t4 + 1;
    let queryLen = -1;
    let refLen = 0;
    let cigarKnown = false;
    if (t5 === cs) this.emptyField(5, cs, ctx);
    else if (t5 - cs === 1 && b[cs] === STAR) { /* not available */ }
    else {
      let i = cs, q = 0, r = 0, ops = 0, firstIsH = false, pendingS = -1, pendingH = -1, clipAt = -1, clipIsH = false, bad = false, back = -1;
      while (i < t5) {
        const opStart = i;
        let c = b[i]!;
        let len = 0;
        while (c >= 48 && c <= 57) { len = len * 10 + (c - 48); c = ++i < t5 ? b[i]! : 0; }
        let op = i < t5 ? CIGAR_OP[c]! : 0;
        // `B` (back) left the specification long ago; htslib still reads it, so it is reported on its own.
        if (op === 0 && c === 66 && i > opStart && i < t5) { op = OP_VALID; if (back < 0) back = opStart; }
        if (i === opStart || op === 0 || len >= CIGAR_LEN_LIMIT) { this.badCigar(l, cs, t5, opStart, i, ctx); bad = true; break; }
        if (pendingH >= 0 && clipAt < 0) { clipAt = pendingH; clipIsH = true; }
        if (op & OP_H) { if (ops > 0) pendingH = opStart; }
        else {
          if (pendingS >= 0 && clipAt < 0) clipAt = pendingS;
          if ((op & OP_S) && !(ops === 0 || (ops === 1 && firstIsH))) pendingS = opStart;
        }
        if (ops === 0) firstIsH = (op & OP_H) !== 0;
        if (op & OP_QUERY) q += len;
        if (op & OP_REF) r += len;
        ops++;
        i++;
      }
      if (!bad && back >= 0) {
        let e = back;
        while (b[e] !== 66) e++;
        ctx.report(S.cigarBackOperation, back, e + 1, `CIGAR \`${show(ascii(b, cs, t5), 40)}\` uses the obsolete \`B\` (back) operation`, {
          hint: 'rewrite the alignment without `B`: describe overlapping segments as separate records (the second one flagged supplementary)',
        });
      } else if (!bad) {
        queryLen = q; refLen = r; cigarKnown = true;
        if (clipAt >= 0) this.badClipping(l, cs, t5, clipAt, clipIsH, ctx);
      }
    }

    // 7 RNEXT
    const ns = t5 + 1;
    if (t6 === ns) this.emptyField(6, ns, ctx);
    else if (t6 - ns === 1 && (b[ns] === EQUALS || b[ns] === STAR)) { /* same as RNAME, or none */ }
    else if (ref !== REF_STAR && ref !== REF_INVALID && sameBytes(b, ns, t6, this.rnameBuf, this.rnameLen)) { /* spelled out, same as RNAME: already checked */ }
    else if (!sameBytes(b, ns, t6, this.rnextBuf, this.rnextLen)) {
      const len = t6 - ns;
      if (len > this.rnextBuf.length) this.rnextBuf = new Uint8Array(len * 2);
      this.rnextBuf.set(b.subarray(ns, t6));
      this.rnextLen = len;
      this.rnextRef = this.resolveReference(ascii(b, ns, t6), 'RNEXT', ns, ctx);
      this.rnextHint = this.lastHint;
      this.rnextAlias = this.rnextRef >= 0 && this.lastHint !== '';
    } else if (this.rnextRef === REF_UNKNOWN) this.unknownReference(ascii(b, ns, t6), 'RNEXT', ns, this.rnextHint, ctx);
    else if (this.rnextAlias) this.aliasUsed(ascii(b, ns, t6), 'RNEXT', ns, this.rnextHint, ctx);

    // 8 PNEXT
    let pnext = parseUInt(b, t6 + 1, t7);
    if (pnext < 0) pnext = this.slowInt(l, 7, t6 + 1, t7, S.posInvalid, ctx);
    if (pnext > INT32_MAX) ctx.report(S.coordinateRange, t6 + 1, t7, `PNEXT ${pnext} is larger than 2147483647 (2^31-1)`, { hint: 'no reference allowed by the specification is this long' });

    // 9 TLEN
    const ts = t7 + 1;
    let tlen = b[ts] === MINUS ? parseUInt(b, ts + 1, t8) : parseUInt(b, ts, t8);
    if (tlen < 0) tlen = this.slowInt(l, 8, ts, t8, S.tlenInvalid, ctx);
    if (tlen > INT32_MAX) ctx.report(S.coordinateRange, ts, t8, `TLEN ${ascii(b, ts, Math.min(t8, ts + 24))} is outside -2147483647..2147483647`, { hint: 'a template cannot be longer than the longest reference; write 0 when the template length is unknown' });

    // 10 SEQ
    const ss = t8 + 1;
    let seqLen = -1;      // -1: `*`; -2: empty field
    if (t9 === ss) { this.emptyField(9, ss, ctx); seqLen = -2; }
    else if (t9 - ss === 1 && b[ss] === STAR) { /* not stored */ }
    else {
      let invalid = -1, unstorable = -1;
      for (let i = ss; i < t9; i++) {
        const k = SEQ_CLASS[b[i]!]!;
        if (k !== 1) { if (k === 0) { invalid = i; break; } if (unstorable < 0) unstorable = i; }
      }
      seqLen = t9 - ss;
      if (invalid >= 0) this.badSeq(l, ss, t9, invalid, ctx);
      else if (unstorable >= 0) {
        const ch = String.fromCharCode(b[unstorable]!);
        ctx.report(S.seqNotStorable, unstorable, unstorable + 1, `SEQ contains \`${ch}\`, which BAM cannot store (samtools reads it as \`${ch === 'U' || ch === 'u' ? 'T' : 'N'}\`)`, {
          hint: ch === 'U' || ch === 'u' ? 'write RNA bases as `T`' : ch === '.' ? 'write `N` for an unknown base, or `=` for a base equal to the reference' : 'use the IUPAC codes `ACMGRSVTWYHKDBN`',
        });
      }
    }

    // 11 QUAL
    const qs = t9 + 1;
    if (qualEnd === qs) this.emptyField(10, qs, ctx);
    else if (qualEnd - qs === 1 && b[qs] === STAR) { /* not stored (also with a one-base SEQ: SAM v1 §1.4, footnote on QUAL) */ }
    else {
      let badAt = -1;
      for (let i = qs; i < qualEnd; i++) {
        const c = b[i]!;
        // Control characters are reported by the engine; a space or a byte above `~` is ours.
        if (c === 32 || c > 127) { badAt = i; break; }
      }
      if (badAt >= 0) {
        const c = b[badAt]!;
        ctx.report(S.qualInvalid, badAt, badAt + 1, c === 32 ? 'QUAL contains a space' : `QUAL contains byte 0x${c.toString(16).toUpperCase()}, which is not a quality character`, {
          hint: c === 32 ? 'qualities are the characters `!` to `~` (Phred+33); a space usually means two columns were joined or the line was edited by hand' : 'qualities are the ASCII characters `!` to `~` (Phred+33)',
        });
      } else if (seqLen === -1) {
        ctx.report(S.qualLength, qs, qualEnd, `QUAL has ${qualEnd - qs} characters but SEQ is \`*\``, { hint: 'write `*` for QUAL when the sequence is not stored, or restore SEQ' });
      } else if (seqLen >= 0 && qualEnd - qs !== seqLen) {
        ctx.report(S.qualLength, qs, qualEnd, `QUAL has ${qualEnd - qs} characters but SEQ has ${seqLen} bases`, { hint: 'the two must be the same length: trim both fields together, or write `*` for QUAL; a mismatch on the last line means the file is truncated' });
      }
    }

    // Consistency between fields.
    if (cigarKnown && seqLen >= 0 && queryLen !== seqLen) {
      ctx.report(S.cigarSeqLength, cs, t5, `CIGAR \`${show(ascii(b, cs, t5), 40)}\` describes ${queryLen} read bases but SEQ has ${seqLen}`, {
        hint: 'the lengths of M, I, S, = and X must add up to the length of SEQ: if bases were trimmed after alignment, the CIGAR must be trimmed too; hard-clipped (H) bases are not part of SEQ',
      });
    }
    if (flag >= 0 && (flag & 0x4) === 0 && pos >= 0 && (ref === REF_STAR || pos === 0 || (t5 - cs === 1 && b[cs] === STAR))) {
      const what = ref === REF_STAR ? 'RNAME is `*`' : pos === 0 ? 'POS is 0' : 'CIGAR is `*`';
      ctx.report(S.mappedIncomplete, t0 + 1, t1, `FLAG ${flag} says the read is mapped, but ${what}`, { hint: `samtools treats this record as unmapped; if it was not aligned, set the unmapped bit: FLAG ${flag | 4}` });
    }
    if (ref >= 0 && pos > 0) {
      const len = this.sqLength[ref]!;
      if (len > 0) {
        if (pos > len) {
          ctx.report(S.posBeyondReference, t2 + 1, t3, `POS ${pos} is beyond the end of \`${show(ascii(b, rs, t2))}\` (LN:${len})`, {
            hint: 'the header probably describes a different reference build than the one used for alignment',
            notes: [`@SQ line ${this.sqLine[ref]}`],
          });
        } else if (cigarKnown && refLen > 1 && pos + refLen - 1 > len && flag >= 0 && (flag & 0x4) === 0 && !this.sqCircular[ref]) {
          ctx.report(S.posBeyondReference, t2 + 1, t5, `the alignment ends at ${pos + refLen - 1}, beyond the end of \`${show(ascii(b, rs, t2))}\` (LN:${len})`, {
            hint: 'check that the header matches the reference used for alignment; if the reference is circular, add `TP:circular` to its @SQ line',
            notes: [`@SQ line ${this.sqLine[ref]}`],
          });
        }
      }
    }
    if (ref === REF_NO_HEADER && !this.noSqReported) {
      this.noSqReported = true;
      ctx.report(S.noSqHeader, rs, t2, this.headerLines > 0 ? 'records name a reference sequence, but the header has no `@SQ` lines' : 'records name a reference sequence, but the file has no header', {
        hint: 'samtools cannot read this file as it is: supply the reference index (`samtools view -t ref.fa.fai in.sam`), or write the file again with its header (`samtools view -h`)',
      });
    }

    // Sort order: only the previous record's key is kept.
    if (this.sortOrder === 'coordinate') {
      if (!this.sortReported && (ref >= 0 || ref === REF_STAR) && pos >= 0 && this.sq.size > 0) {
        const r = ref === REF_STAR ? Infinity : ref;
        const p = ref === REF_STAR ? 0 : pos;
        if (r < this.prevRef || (r === this.prevRef && p < this.prevPos)) {
          this.sortReported = true;
          const here = `\`${show(ascii(b, rs, t2))}\`:${pos}`;
          const before = this.prevRef === Infinity ? 'a record without a reference (`*`)' : `\`${show(this.prevRefName)}\`:${this.prevPos}`;
          ctx.report(S.notCoordinateSorted, r < this.prevRef ? rs : t2 + 1, r < this.prevRef ? t2 : t3, `the header says \`SO:coordinate\`, but ${here} comes after ${before}`, {
            hint: 'sort the file (`samtools sort`), or correct the header to `SO:unsorted`; indexing a file in this state fails',
            notes: r < this.prevRef && this.prevRef !== Infinity ? ['references are ordered as their @SQ lines are, not alphabetically'] : [],
          });
        }
        if (r !== this.prevRef) this.prevRefName = ref === REF_STAR ? '*' : ascii(b, rs, t2);
        this.prevRef = r;
        this.prevPos = p;
      }
    } else if (this.sortOrder === 'queryname' && !this.sortReported && t0 > 0 && t0 <= 254) {
      if (this.qnameLen >= 0) {
        if (this.lexSorted && lexCompare(this.qnameBuf, this.qnameLen, b, 0, t0) > 0) this.lexSorted = false;
        if (this.naturalSorted && naturalCompare(this.qnameBuf, this.qnameLen, b, 0, t0) > 0) this.naturalSorted = false;
        if (!this.lexSorted && !this.naturalSorted) {
          this.sortReported = true;
          ctx.report(S.notQuerynameSorted, 0, t0, `the header says \`SO:queryname\`, but \`${show(ascii(b, 0, t0))}\` comes after \`${show(ascii(this.qnameBuf, 0, this.qnameLen))}\``, {
            hint: 'sort the file by name (`samtools sort -n`), or correct the header to `SO:unsorted`',
          });
        }
      }
      this.qnameBuf.set(b.subarray(0, t0));
      this.qnameLen = t0;
    }

    // Optional fields.
    if (nt === 11) {
      const seen = this.seenTag;
      let p = t[10]! + 1;
      for (;;) {
        let e = b.indexOf(TAB, p);
        if (e < 0) e = n;
        if (e === p) {
          if (e === n) ctx.report(S.trailingTab, p - 1, p, 'the line ends with a tab, which starts an empty optional field', { hint: 'remove the tab at the end of the line' });
          else ctx.report(S.auxMalformed, p - 1, p + 1, 'empty optional field between two tabs', { hint: 'remove the extra tab' });
        } else if (e - p < 5 || b[p + 2] !== COLON || b[p + 4] !== COLON) {
          this.badAux(l, p, e, ctx);
        } else {
          const c1 = b[p]!, c2 = b[p + 1]!;
          if (!(ALNUM[c1] === 1 && ALNUM[c2]! > 0)) {
            ctx.report(S.auxTagInvalid, p, p + 2, `tag \`${show(ascii(b, p, p + 2))}\` is not a letter followed by a letter or digit`, { hint: 'rename the tag; lower-case tags and tags starting with X, Y or Z are free for your own use' });
          }
          const key = (c1 << 8) | c2;
          if (seen[key] === record) {
            ctx.report(S.auxTagDuplicate, p, p + 2, `tag \`${show(ascii(b, p, p + 2))}\` appears more than once in this record`, { hint: 'keep one copy: tools return the first and ignore the rest' });
          } else seen[key] = record;
          const type = b[p + 3]!;
          if (this.auxValue(l, type, p, p + 5, e, key, ctx)) {
            const expected = PREDEFINED_TYPE[key]!;
            if (expected !== 0 && expected !== type) {
              const tag = ascii(b, p, p + 2), want = String.fromCharCode(expected);
              ctx.report(S.auxTypeMismatch, p + 3, p + 4, `\`${tag}\` is a predefined tag of type \`${want}\` (${TYPE_NAMES[want]}), not \`${String.fromCharCode(type)}\``, {
                hint: `write it as \`${tag}:${want}:...\`, or use a tag of your own (lower case, or starting with X, Y or Z) for different data`,
              });
            }
          }
        }
        if (e === n) break;
        p = e + 1;
      }
    }
  }

  /** Check one optional field's value. Returns false when the type letter itself is unknown. */
  private auxValue(l: Line, type: number, p: number, v: number, e: number, key: number, ctx: Context): boolean {
    const b = l.bytes;
    switch (type) {
      case 105: { // i
        let i = v;
        if (i < e && (b[i] === PLUS || b[i] === MINUS)) i++;
        const d0 = i;
        while (i < e && b[i]! >= 48 && b[i]! <= 57) i++;
        if (i !== e || i === d0) { this.badAuxValue(l, p, v, e, 'i', ctx); return true; }
        if (e - d0 > 9) {
          const x = Number(ascii(b, v, e));
          if (x < -2147483648 || x > UINT32_MAX) {
            ctx.report(S.auxValueInvalid, v, e, `integer ${show(ascii(b, v, e), 30)} is outside the range -2147483648 to 4294967295`, { hint: 'BAM cannot store it and samtools refuses the record; store large numbers as text (`Z`) or as a float (`f`)' });
          }
        }
        return true;
      }
      case 90: { // Z
        let hi = 0;
        for (let i = v; i < e; i++) hi |= b[i]!;
        if (hi > 127) {
          let at = v;
          while (b[at]! < 128) at++;
          ctx.report(S.auxValueNonstandard, at, e, `string value of \`${ascii(b, p, p + 2)}\` contains non-ASCII characters`, { hint: 'a `Z` value is printable ASCII (space to `~`); transliterate or percent-encode other characters' });
        }
        if (key === KEY_RG) this.readGroupTag(b, v, e, ctx);
        else if (key === KEY_PG) this.programTag(b, v, e, ctx);
        return true;
      }
      case 65: { // A
        if (e - v !== 1) { this.badAuxValue(l, p, v, e, 'A', ctx); return true; }
        const c = b[v]!;
        if (c === 32 || c > 127) ctx.report(S.auxValueNonstandard, v, e, c === 32 ? `character value of \`${ascii(b, p, p + 2)}\` is a space` : `character value of \`${ascii(b, p, p + 2)}\` is not ASCII`, { hint: 'an `A` value is one printable character from `!` to `~`' });
        return true;
      }
      case 102: { // f
        const kind = specFloat(b, v, e);
        if (kind === 0) this.badAuxValue(l, p, v, e, 'f', ctx);
        else if (kind === 2 && Math.abs(Number(ascii(b, v, e))) > FLOAT_MAX) {
          ctx.report(S.auxValueNonstandard, v, e, `${show(ascii(b, v, e), 30)} is too large for a single-precision number`, { hint: 'an `f` value is stored in 32 bits (at most about 3.4e38); samtools turns this one into `inf`' });
        }
        return true;
      }
      case 72: { // H
        let lower = -1;
        for (let i = v; i < e; i++) {
          const k = HEX[b[i]!]!;
          if (k === 0) { this.badAuxValue(l, p, v, e, 'H', ctx); return true; }
          if (k === 2 && lower < 0) lower = i;
        }
        if ((e - v) & 1) this.badAuxValue(l, p, v, e, 'H', ctx);
        else if (lower >= 0) ctx.report(S.auxValueNonstandard, lower, lower + 1, `hex value of \`${ascii(b, p, p + 2)}\` uses lower-case digits`, { hint: `write hexadecimal digits in upper case: \`${show(ascii(b, v, e).toUpperCase(), 40)}\`` });
        return true;
      }
      case 66: // B
        this.auxArray(l, p, v, e, ctx);
        return true;
      case 73: // I: htslib reads it as an integer
      case 100: { // d: htslib keeps it as a double
        const tag = ascii(b, p, p + 2);
        ctx.report(S.auxTypeBamOnly, p + 3, p + 4, type === 73 ? `type \`I\` of \`${tag}\` is a BAM storage size, not a SAM type` : `type \`d\` of \`${tag}\` is not a SAM type`, {
          hint: type === 73 ? `in SAM text every integer has type \`i\`: write \`${tag}:i:${show(ascii(b, v, e), 20)}\`` : `SAM has no double-precision type: write \`${tag}:f:${show(ascii(b, v, e), 20)}\``,
        });
        return false;
      }
      default: {
        const tag = ascii(b, p, p + 2), ch = String.fromCharCode(type);
        let hint = 'the type is one of `A` (character), `i` (integer), `f` (number), `Z` (string), `H` (hex) or `B` (array)';
        if ('cCsS'.includes(ch)) hint = `\`${ch}\` is a BAM storage size; in SAM text every integer has type \`i\`: write \`${tag}:i:${show(ascii(b, v, e), 20)}\``;
        else if ('azhb'.includes(ch)) hint = `types are case-sensitive: write \`${tag}:${ch.toUpperCase()}:...\``;
        else if (ch === 'F') hint = `types are case-sensitive: write \`${tag}:f:...\``;
        ctx.report(S.auxTypeUnknown, p + 3, p + 4, `\`${show(ch)}\` is not an optional field type`, { hint });
        return false;
      }
    }
  }

  private auxArray(l: Line, p: number, v: number, e: number, ctx: Context): void {
    const b = l.bytes;
    const tag = ascii(b, p, p + 2);
    if (v === e) { this.badAuxValue(l, p, v, e, 'B', ctx); return; }
    const sub = b[v]!;
    const range = B_RANGE[sub];
    if (!range && sub !== 102) {
      const ch = String.fromCharCode(sub);
      ctx.report(S.auxValueInvalid, v, v + 1, `\`${show(ch)}\` is not an array element type`, {
        hint: 'ifcs'.includes(ch.toLowerCase()) ? `element types are case-sensitive: \`c C s S i I\` for integers of 8, 16 and 32 bits (upper case = unsigned) and \`f\` for numbers` : 'a `B` value starts with one of `c C s S i I f`, then a comma before each number, e.g. `B:i,1,2,3`',
      });
      return;
    }
    if (v + 1 === e) return; // an empty array
    if (b[v + 1] !== COMMA) {
      ctx.report(S.auxValueInvalid, v + 1, e, `array element type \`${String.fromCharCode(sub)}\` is not followed by a comma`, { hint: `write \`${tag}:B:${String.fromCharCode(sub)},${show(ascii(b, v + 1, e), 20)}\`` });
      return;
    }
    let i = v + 2;
    let outOfRange = -1, outEnd = -1, loose = -1, looseEnd = -1;
    for (;;) {
      let q = i;
      while (q < e && b[q] !== COMMA) q++;
      // element [i, q)
      if (q === i) {
        ctx.report(S.auxValueInvalid, i - 1, Math.min(e, i + 1), q === e ? `array value of \`${tag}\` ends with a comma` : `array value of \`${tag}\` has an empty element`, { hint: 'remove the extra comma; samtools reads an empty element as 0' });
        return;
      }
      if (range) {
        let k = i;
        const neg = b[k] === MINUS;
        if (neg || b[k] === PLUS) k++;
        let x = 0;
        const d0 = k;
        while (k < q && b[k]! >= 48 && b[k]! <= 57) { x = x * 10 + (b[k]! - 48); k++; }
        if (k !== q || k === d0) {
          const text = ascii(b, i, q);
          ctx.report(S.auxValueInvalid, i, q, `array element \`${show(text, 24)}\` is not an integer`, {
            hint: specFloat(b, i, q) ? `the element type \`${String.fromCharCode(sub)}\` holds integers; use \`B:f\` for an array of numbers` : 'array elements are numbers separated by commas',
          });
          return;
        }
        if (neg) x = -x;
        if (x < -2147483648 || x > UINT32_MAX) {
          ctx.report(S.auxValueInvalid, i, q, `array element ${show(ascii(b, i, q), 24)} does not fit in 32 bits`, { hint: 'integer array elements range from -2147483648 to 4294967295; use `B:f` or a string for larger values' });
          return;
        }
        if ((x < range[0] || x > range[1]) && outOfRange < 0) { outOfRange = i; outEnd = q; }
      } else {
        const kind = specFloat(b, i, q);
        if (kind === 0) {
          const text = ascii(b, i, q);
          if (!looseFloat(text)) {
            ctx.report(S.auxValueInvalid, i, q, `array element \`${show(text, 24)}\` is not a number`, { hint: 'array elements are numbers separated by commas' });
            return;
          }
          if (loose < 0) { loose = i; looseEnd = q; }
        }
      }
      if (q === e) break;
      i = q + 1;
      if (i === e) {
        ctx.report(S.auxValueInvalid, e - 1, e, `array value of \`${tag}\` ends with a comma`, { hint: 'remove the trailing comma; samtools reads it as an extra element 0' });
        return;
      }
    }
    if (outOfRange >= 0) {
      const ch = String.fromCharCode(sub);
      const fits = Object.entries(B_RANGE).filter(([, r]) => { const x = Number(ascii(b, outOfRange, outEnd)); return x >= r[0] && x <= r[1]; }).map(([k]) => String.fromCharCode(Number(k)));
      ctx.report(S.auxValueNonstandard, outOfRange, outEnd, `array element ${ascii(b, outOfRange, outEnd)} is outside the range of element type \`${ch}\` (${range![0]} to ${range![1]})`, {
        hint: `declare a wider element type, e.g. \`${tag}:B:${fits.includes('i') ? 'i' : fits.includes('I') ? 'I' : 'i'},...\`; samtools silently changes the type to make the values fit`,
      });
    } else if (loose >= 0) {
      ctx.report(S.auxValueNonstandard, loose, looseEnd, `array element \`${show(ascii(b, loose, looseEnd), 24)}\` is not written as the specification's number pattern allows`, { hint: 'write digits on at least one side of the decimal point and none of `nan`, `inf` or hexadecimal' });
    }
  }

  private readGroupTag(b: Uint8Array, v: number, e: number, ctx: Context): void {
    if (!sameBytes(b, v, e, this.rgBuf, this.rgLen)) {
      const len = e - v;
      if (len > this.rgBuf.length) this.rgBuf = new Uint8Array(len * 2);
      this.rgBuf.set(b.subarray(v, e));
      this.rgLen = len;
      this.rgHint = '';
      if (this.readGroups.size === 0) this.rgState = this.headerLines > 0 ? RG_NO_HEADER : RG_OK;
      else {
        const id = ascii(b, v, e);
        this.rgState = this.readGroups.has(id) ? RG_OK : RG_UNDECLARED;
        if (this.rgState === RG_UNDECLARED) {
          const near = this.readGroups.size <= 200 ? suggest(id, [...this.readGroups.keys()]) : undefined;
          this.rgHint = near ? `did you mean \`RG:Z:${near}\`? otherwise add \`@RG\tID:${show(id, 30)}\` to the header` : `add an @RG line with \`ID:${show(id, 30)}\` to the header, or fix the tags with \`samtools addreplacerg\``;
          this.rgHint = this.rgHint.replace('\t', '<tab>');
        }
      }
    }
    if (this.rgState === RG_UNDECLARED) {
      ctx.report(S.rgUndeclared, v, e, `read group \`${show(ascii(b, v, e))}\` is not defined by any @RG line`, { hint: this.rgHint });
    } else if (this.rgState === RG_NO_HEADER && !this.rgHeaderReported) {
      this.rgHeaderReported = true;
      ctx.report(S.rgHeaderMissing, v, e, `reads carry \`RG:Z:${show(ascii(b, v, e), 30)}\`, but the header has no @RG lines`, { hint: `add \`@RG<tab>ID:${show(ascii(b, v, e), 30)}<tab>SM:<sample>\` to the header (\`samtools addreplacerg\` can do this)` });
    }
  }

  private programTag(b: Uint8Array, v: number, e: number, ctx: Context): void {
    if (!sameBytes(b, v, e, this.pgBuf, this.pgLen)) {
      const len = e - v;
      if (len > this.pgBuf.length) this.pgBuf = new Uint8Array(len * 2);
      this.pgBuf.set(b.subarray(v, e));
      this.pgLen = len;
      this.pgState = this.programs.size === 0 || this.programs.has(ascii(b, v, e)) ? RG_OK : RG_UNDECLARED;
    }
    if (this.pgState === RG_UNDECLARED) {
      const id = ascii(b, v, e);
      const near = this.programs.size <= 200 ? suggest(id, [...this.programs.keys()]) : undefined;
      ctx.report(S.pgUndeclared, v, e, `program \`${show(id)}\` is not defined by any @PG line`, { hint: near ? `did you mean \`PG:Z:${near}\`?` : `add an @PG line with \`ID:${show(id, 30)}\`, or remove the tag` });
    }
  }

  // ------------------------------------------------------------------ slow paths: something is wrong with the line

  private lastHint = '';

  /** Look a reference name up in the header. Reports invalid characters and unknown names. */
  private resolveReference(name: string, field: 'RNAME' | 'RNEXT', col: number, ctx: Context): number {
    this.lastHint = '';
    const problem = nameProblem(name);
    if (problem) {
      const whole = problem.at === 0 && problem.what.startsWith('starts');
      ctx.report(S.rnameInvalid, col + problem.at, col + problem.at + 1, `${field} \`${show(name)}\` ${problem.what}`, {
        hint: whole && name.length > 1 ? `\`${name[0]}\` is only valid on its own; a reference name cannot start with it` : name.includes(' ') ? 'reference names cannot contain spaces: check that the columns are separated by tabs, and that the reference FASTA names stop at the first space' : nameHint(name),
      });
    }
    if (this.sq.size === 0) return REF_NO_HEADER;
    const idx = this.sq.get(name);
    if (idx !== undefined) return idx;
    // Work the hint out once per name; the name is likely to repeat on many lines.
    const alt = name.startsWith('chr') ? name.slice(3) : 'chr' + name;
    const alias = this.altRef.get(name);
    if (alias !== undefined) {
      this.lastHint = this.sqName(alias);
      this.aliasUsed(name, field, col, this.lastHint, ctx);
      return alias;
    }
    if (this.sq.has(alt)) this.lastHint = `the header declares \`${show(alt)}\`: header and records use different naming (\`chr\` prefix), so they come from different reference files`;
    else if (name === 'chrM' && this.sq.has('MT')) this.lastHint = 'the header declares `MT`: header and records come from different reference files';
    else if (name === 'MT' && this.sq.has('chrM')) this.lastHint = 'the header declares `chrM`: header and records come from different reference files';
    else {
      const near = this.sq.size <= 200 ? suggest(name, [...this.sq.keys()]) : undefined;
      this.lastHint = near ? `did you mean \`${show(near)}\`? otherwise the header belongs to a different reference: rebuild it with \`samtools view -T ref.fa\`` : 'the header belongs to a different reference than the one the reads were aligned to: rebuild it with `samtools view -T ref.fa` or `samtools reheader`';
    }
    this.unknownReference(name, field, col, this.lastHint, ctx);
    return REF_UNKNOWN;
  }

  private sqName(index: number): string {
    for (const [name, i] of this.sq) if (i === index) return name;
    return '';
  }

  private aliasUsed(name: string, field: 'RNAME' | 'RNEXT', col: number, primary: string, ctx: Context): void {
    ctx.report(S.rnameIsAlias, col, col + name.length, `${field} \`${show(name)}\` is an alternative name (\`AN\`) of \`${show(primary)}\`, not its \`SN\``, {
      hint: `write \`${show(primary)}\`: alternative names are for user queries and must not be used in records (samtools replaces it on reading)`,
      notes: [`@SQ line ${this.sqLine[this.sq.get(primary)!]}`],
    });
  }

  private unknownReference(name: string, field: 'RNAME' | 'RNEXT', col: number, hint: string, ctx: Context): void {
    ctx.report(S.rnameUnknown, col, col + name.length, `${field} \`${show(name)}\` is not the \`SN\` of any @SQ line`, { hint });
  }

  private tooFewFields(l: Line, count: number, ctx: Context): void {
    const text = l.text;
    if (text.trim() === '') {
      ctx.report(S.blankLine, -1, -1, 'line contains only whitespace', { hint: 'delete the line: samtools reads it as a malformed alignment and stops' });
      return;
    }
    const words = text.trim().split(/[ \t]+/).length;
    let hint = 'each alignment needs QNAME, FLAG, RNAME, POS, MAPQ, CIGAR, RNEXT, PNEXT, TLEN, SEQ and QUAL, separated by tabs; write `*` or `0` for a field with no value';
    if (words >= 11 && text.includes(' ')) hint = 'the columns are separated by spaces: SAM fields must be separated by single tab characters (an editor or a copy from a terminal may have converted them)';
    else if (/^[>@]/.test(text) && count <= 2) hint = 'this does not look like an alignment line; if it is a header line it needs a known record type and must come before the first alignment';
    else if (count === 10) hint = 'one field is missing; QUAL is the usual one: write `*` when base qualities are not stored';
    ctx.report(S.tooFewFields, -1, -1, `alignment line has ${count} tab-separated field${count === 1 ? '' : 's'}; 11 are required`, { hint });
  }

  private emptyField(field: number, col: number, ctx: Context): void {
    ctx.report(S.fieldEmpty, Math.max(0, col - 1), col + 1, `${FIELD_NAMES[field]} (column ${field + 1}) is empty`, { hint: `write \`${PLACEHOLDER[field]}\` when there is no value; two tabs in a row usually mean a script printed an empty variable` });
  }

  private badQname(l: Line, at: number, end: number, ctx: Context): void {
    const name = l.text.slice(0, end);
    const c = l.bytes[at]!;
    if (c < 32 || c === 127) return; // control characters are reported by the engine
    let message: string, hint: string;
    if (c === AT && at === 0) {
      message = `read name \`${show(name)}\` starts with \`@\``;
      hint = 'remove the `@` (it is the FASTQ record marker, not part of the name); at the top of a file such a line is taken for a header line';
    } else if (c === AT) {
      message = `read name \`${show(name)}\` contains \`@\``;
      hint = 'read names may use any printable character except `@` and space; replace it, e.g. with `_`';
    } else if (c === 32) {
      message = `read name \`${show(name)}\` contains a space`;
      hint = `use the part before the space (\`${show(name.slice(0, at))}\`): the rest is the FASTQ comment, which belongs in a \`CO:Z:\` or \`BC:Z:\` tag (bwa mem -C does this)`;
    } else {
      message = `read name \`${show(name)}\` contains a non-ASCII character`;
      hint = 'read names are printable ASCII (`!` to `~`, except `@`)';
    }
    ctx.report(S.qnameInvalid, at, at + 1, message, { hint });
  }

  private badFlag(l: Line, s: number, e: number, ctx: Context): void {
    if (s === e) { this.emptyField(1, s, ctx); return; }
    const text = l.text.slice(s, e);
    let hint = 'FLAG is the sum of the bit values that apply, as a decimal number from 0 to 4095; `samtools flags` translates between names and numbers';
    let message = `FLAG \`${show(text)}\` is not a decimal integer`;
    if (/^0[xX][0-9a-fA-F]+$/.test(text)) hint = `write the value in decimal: \`${parseInt(text, 16)}\``;
    else if (/^0[0-9]+$/.test(text)) hint = `remove the leading zero${/^00/.test(text) ? 's' : ''}: samtools reads a number that starts with 0 as octal${/^0[0-7]+$/.test(text) ? ` (\`${text}\` becomes ${parseInt(text, 8)})` : ' and rejects this one'}`;
    else if (/^[0-9]+$/.test(text)) { message = `FLAG ${show(text, 24)} is larger than 65535`; hint = 'only bits 0x1 to 0x800 are defined, so a valid FLAG is at most 4095: the column may hold something other than a flag'; }
    else if (/^-[0-9]+$/.test(text)) hint = 'a FLAG cannot be negative; write 0 when no bit applies, or 4 for an unmapped read';
    else if (/^\+[0-9]+$/.test(text)) hint = `remove the plus sign: \`${text.slice(1)}\``;
    else if (/^[0-9]+\.0*$/.test(text)) hint = `drop the decimal point: \`${text.replace(/\..*$/, '')}\``;
    else if (/^[A-Za-z,_]+$/.test(text)) hint = 'flag names are not allowed in the file; convert them with `samtools flags`, e.g. `PAIRED,UNMAP` is 5';
    ctx.report(S.flagInvalid, s, e, message, { hint });
  }

  private flagProblem(flag: number, kind: 1 | 2 | 3, s: number, e: number, ctx: Context): void {
    if (!ctx.enabled(S.flagInconsistent)) return;
    if (kind === 3) {
      const extra = flag & 0xf000;
      ctx.report(S.flagInconsistent, s, e, `FLAG ${flag} sets ${extra & (extra - 1) ? 'bits' : 'bit'} ${[0x1000, 0x2000, 0x4000, 0x8000].filter((x) => flag & x).map(hex).join(', ')}, which the specification reserves`, {
        hint: `only 0x1 to 0x800 are defined, so a FLAG is at most 4095; without the reserved bits this one is ${flag & 0xfff}${flag & 0xfff ? ` (${flagBits(flag & 0xfff)})` : ''}`,
      });
    } else if (kind === 1) {
      const stray = flag & 0xea;
      ctx.report(S.flagInconsistent, s, e, `FLAG ${flag} sets ${flagBits(flag, 0xea)} although the read is not marked as paired (0x1)`, {
        hint: `these bits only have a meaning for paired reads: use ${flag | 1} if the read has a mate, or ${flag & ~stray} if it does not`,
        notes: [`${flag} = ${flagBits(flag)}`],
      });
    } else {
      const stray = flag & 0x902;
      ctx.report(S.flagInconsistent, s, e, `FLAG ${flag} marks the read as unmapped (0x4) and also sets ${flagBits(flag, 0x902)}`, {
        hint: `an unmapped read has no alignment to be proper, secondary or supplementary: use ${flag & ~stray}, or ${flag & ~4} if the read is in fact mapped`,
        notes: [`${flag} = ${flagBits(flag)}`],
      });
    }
  }

  /** POS, MAPQ, PNEXT or TLEN that is not a plain decimal. Returns the value when one can be read, otherwise -1. */
  private slowInt(l: Line, field: number, s: number, e: number, rule: RuleMeta, ctx: Context): number {
    if (s === e) { this.emptyField(field, s, ctx); return -1; }
    const name = FIELD_NAMES[field]!;
    const text = l.text.slice(s, e);
    const signed = field === 8;
    if (/^[+-]?[0-9]+$/.test(text) && (signed || text[0] !== '-')) {
      // Readable, but written with a plus sign or leading zeros (or simply very long).
      const canonical = text.replace(/^([+-]?)0+(?=[0-9])/, '$1').replace(/^\+/, '');
      if (canonical !== text) ctx.report(S.integerFormat, s, e, `${name} \`${show(text, 24)}\` is written with ${text[0] === '+' ? 'a plus sign' : 'leading zeros'}`, { hint: `write \`${canonical}\`` });
      return Math.abs(Number(canonical));
    }
    let hint: string;
    if (text === '*') hint = `\`*\` is the placeholder of text fields; ${name} is a number and its placeholder is \`0\`${field === 4 ? ' (or 255 for "not available")' : ''}`;
    else if (/^-[0-9]+$/.test(text)) hint = field === 4 ? 'a mapping quality cannot be negative' : `${name} is 1-based and cannot be negative; write 0 when there is no position`;
    else if (/^[0-9]+\.0*$/.test(text)) hint = `drop the decimal point: \`${text.replace(/\..*$/, '')}\``;
    else if (/^[0-9]+(?:\.[0-9]+)?[eE][+-]?[0-9]+$/.test(text)) hint = `scientific notation is usually a spreadsheet artefact; write the integer, e.g. \`${Number(text).toFixed(0)}\``;
    else if (/^[0-9]{1,3}(?:[,_][0-9]{3})+$/.test(text)) hint = `write it without separators: \`${text.replace(/[,_]/g, '')}\``;
    else if (/^[+-]?[0-9]*\.[0-9]+$/.test(text)) hint = `${name} is a whole number`;
    else if (/^0[xX][0-9a-fA-F]+$/.test(text)) hint = `write the value in decimal: \`${parseInt(text, 16)}\``;
    else hint = `${name} is a whole number; if the columns look shifted, a field before this one is missing or contains a tab`;
    ctx.report(rule, s, e, `${name} \`${show(text, 32)}\` is not ${signed ? 'an integer' : field === 4 ? 'an integer from 0 to 255' : 'a non-negative integer'}`, { hint });
    return -1;
  }

  private badCigar(l: Line, s: number, e: number, opStart: number, at: number, ctx: Context): void {
    const b = l.bytes;
    const cigar = l.text.slice(s, e);
    const quoted = `CIGAR \`${show(cigar, 40)}\``;
    if (at >= e) {
      ctx.report(S.cigarInvalid, opStart, e, `${quoted} ends with a number that has no operation`, { hint: `add the operation letter (e.g. \`${show(l.text.slice(opStart, e), 12)}M\`) or remove the number; the line may be truncated` });
      return;
    }
    const c = b[at]!;
    const ch = l.text[at]!;
    if (CIGAR_OP[c]) {
      if (at === opStart) ctx.report(S.cigarInvalid, at, at + 1, `${quoted} has operation \`${ch}\` without a length`, { hint: /^[MIDNSHP=X][0-9]/.test(l.text.slice(at, e)) ? 'the length comes before the operation: `5M`, not `M5`' : `write the length before the letter, e.g. \`1${ch}\`` });
      else ctx.report(S.cigarInvalid, opStart, at + 1, `${quoted} has an operation of length ${show(l.text.slice(opStart, at), 20)}, above the limit of 268435455`, { hint: 'one CIGAR operation holds at most 2^28-1 bases; split it, e.g. into several N operations' });
      return;
    }
    let hint = 'a CIGAR is a series of lengths and operation letters from `MIDNSHP=X`, e.g. `5S90M1D5M`, or `*` when there is none';
    const upper = ch.toUpperCase();
    if (ch !== upper && CIGAR_OP[upper.charCodeAt(0)]) hint = `operations are upper case: write \`${upper}\``;
    else if (ch === ' ') hint = 'the CIGAR contains a space: check that the columns are separated by tabs';
    else if (/^[ACGTN]+$/i.test(cigar) && cigar.length > 4) hint = 'this looks like a sequence: the columns are probably shifted';
    else if (ch === '-' || ch === '+') hint = 'lengths are unsigned whole numbers';
    ctx.report(S.cigarInvalid, at, at + 1, c < 32 || c > 126 ? `${quoted} contains a character that is not a CIGAR operation` : `${quoted} contains \`${show(ch)}\`, which is not a CIGAR operation`, { hint });
  }

  private badClipping(l: Line, s: number, e: number, at: number, isH: boolean, ctx: Context): void {
    let end = at;
    const b = l.bytes;
    while (end < e && b[end]! >= 48 && b[end]! <= 57) end++;
    end++;
    const cigar = l.text.slice(s, e);
    const op = l.text.slice(at, end);
    ctx.report(S.cigarClipping, at, end, isH ? `hard clip \`${show(op, 16)}\` is inside CIGAR \`${show(cigar, 40)}\`, not at an end` : `soft clip \`${show(op, 16)}\` is inside CIGAR \`${show(cigar, 40)}\`, not at an end`, {
      hint: isH ? '`H` may only be the first or the last operation; use `D` or `N` for reference bases the read skips, and split a chimeric read into supplementary records' : '`S` may only be separated from the ends of the CIGAR by `H`; use `I` for read bases that are not aligned in the middle of an alignment',
    });
  }

  private badSeq(l: Line, s: number, e: number, at: number, ctx: Context): void {
    const c = l.bytes[at]!;
    if (c < 32 || c === 127) return; // control characters are reported by the engine
    const ch = l.text[at]!;
    let hint = 'SEQ is letters (IUPAC base codes), `=` or `.`, or a single `*` when the sequence is not stored';
    if (ch === '-') hint = 'gaps are not written in SEQ: remove the `-` characters and describe the gap in the CIGAR (`D` or `N`)';
    else if (ch === '*') hint = '`*` is only valid alone, meaning "sequence not stored"; padding belongs in the CIGAR (`P`)';
    else if (ch === ' ') hint = 'SEQ contains a space: check that the columns are separated by tabs';
    else if (/[0-9]/.test(ch)) hint = /^[0-9]+$/.test(l.text.slice(s, e)) ? 'this is a number, not a sequence: the columns are probably shifted' : 'digits are not base codes; colour-space reads belong in the `CS:Z:` tag';
    else if (c > 127) hint = 'SEQ is plain ASCII letters';
    ctx.report(S.seqInvalid, at, at + 1, c > 127 ? 'SEQ contains a non-ASCII character' : `SEQ contains \`${show(ch)}\`, which is not a base code`, { hint });
  }

  private badAux(l: Line, p: number, e: number, ctx: Context): void {
    const f = l.text.slice(p, e);
    let hint = 'optional fields have the form `TAG:TYPE:VALUE`, e.g. `NM:i:2` or `RG:Z:sample1`';
    let m: RegExpExecArray | null;
    if ((m = /^([A-Za-z][A-Za-z0-9]):([^:]*)$/.exec(f))) {
      const v = m[2]!;
      hint = `the type is missing: write \`${m[1]}:${/^[-+]?[0-9]+$/.test(v) ? 'i' : /^[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?$/.test(v) ? 'f' : 'Z'}:${show(v, 24)}\``;
    } else if (/^[A-Za-z][A-Za-z0-9]:[A-Za-z]$/.test(f)) hint = 'the value is missing; a field with an empty value is written with both colons, e.g. `XX:Z:`';
    else if ((m = /^([A-Za-z][A-Za-z0-9])=(.*)$/.exec(f))) hint = `SAM uses colons, not \`=\`: write \`${m[1]}:Z:${show(m[2]!, 24)}\` (or \`:i:\` for an integer)`;
    else if (/^[^:]{3,}:[A-Za-z]:/.test(f) || /^[^:]:[A-Za-z]:/.test(f)) hint = 'a tag is exactly two characters';
    else if (/^[!-~]+$/.test(f) && !f.includes(':') && f.length > 8) hint = 'this does not look like an optional field: the line may have more than eleven mandatory columns, or a tab inside a field';
    ctx.report(S.auxMalformed, p, e, `optional field \`${show(f)}\` is not \`TAG:TYPE:VALUE\``, { hint });
  }

  private badAuxValue(l: Line, p: number, v: number, e: number, type: 'A' | 'i' | 'f' | 'H' | 'B', ctx: Context): void {
    const tag = l.text.slice(p, p + 2);
    const value = l.text.slice(v, e);
    const space = value.indexOf(' ');
    const glued = space > 0 && /^ +[A-Za-z][A-Za-z0-9]:[AifZHB]:/.test(value.slice(space));
    if (type === 'A') {
      ctx.report(S.auxValueInvalid, v, Math.max(e, v + 1), value === '' ? `character value of \`${tag}\` is empty` : `character value \`${show(value, 24)}\` of \`${tag}\` is ${[...show(value, 1000)].length} characters long`, {
        hint: value === '' ? 'an `A` value is exactly one printable character; delete the field if there is no value' : `an \`A\` value is exactly one character (samtools keeps only the first); use \`${tag}:Z:${show(value, 24)}\` for text`,
      });
    } else if (type === 'i') {
      let hint = 'an `i` value is a whole number, optionally signed';
      if (value === '') hint = 'give a number or delete the field';
      else if (glued) hint = 'two fields are separated by a space instead of a tab; samtools reads the first and drops the rest';
      else if (/^[-+]?[0-9]*\.[0-9]+(?:[eE][-+]?[0-9]+)?$/.test(value) || /^[-+]?[0-9]+[eE][-+]?[0-9]+$/.test(value) || /^[-+]?[0-9]+\.$/.test(value)) hint = `this is not a whole number (samtools reads it as ${parseInt(value, 10) || 0}): use type \`f\`, \`${tag}:f:${show(value, 24)}\`, or round the value`;
      else if (/^[-+]?(?:nan|inf)/i.test(value) || value === 'NA' || value === '.' || value === '*') hint = 'there is no "missing" integer (samtools reads this as 0): leave the field out when the value is unknown';
      else if (/^[0-9,]+$/.test(value)) hint = `for several integers use an array: \`${tag}:B:i,${show(value, 24)}\``;
      else if (/[A-Za-z]/.test(value)) hint = `this is text (samtools reads it as 0): use type \`Z\`, \`${tag}:Z:${show(value, 24)}\``;
      ctx.report(S.auxValueInvalid, v, Math.max(e, v + 1), value === '' ? `integer value of \`${tag}\` is empty` : `\`${show(value, 32)}\` is not an integer (\`${tag}\` has type \`i\`)`, { hint });
    } else if (type === 'f') {
      if (value !== '' && looseFloat(value)) {
        const special = /nan|inf/i.test(value);
        ctx.report(S.auxValueNonstandard, v, e, special ? `\`${show(value, 24)}\` is not a number the specification's \`f\` pattern allows` : `number \`${show(value, 24)}\` is not written as the specification's \`f\` pattern allows`, {
          hint: special ? 'samtools reads and writes `nan` and `inf`, but the pattern for `f` has digits only: leave the field out when the value is undefined' : /^[-+]?[0-9]+\.(?:[eE]|$)/.test(value) ? `write a digit after the decimal point or drop the point: \`${show(value.replace(/\.(?=[eE]|$)/, ''), 24)}\`` : 'write the number in decimal notation, e.g. `8` or `0.5e3`',
        });
        return;
      }
      let hint = 'an `f` value is a decimal number such as `0.5`, `-3` or `1.2e-5`';
      if (value === '') hint = 'give a number or delete the field';
      else if (glued) hint = 'two fields are separated by a space instead of a tab';
      else if (/^[-+]?[0-9]+,[0-9]+$/.test(value)) hint = `use a point as the decimal separator: \`${value.replace(',', '.')}\``;
      else if (/[A-Za-z]/.test(value)) hint = `this is text (samtools reads it as 0): use type \`Z\`, or leave the field out when the value is unknown`;
      ctx.report(S.auxValueInvalid, v, Math.max(e, v + 1), value === '' ? `number value of \`${tag}\` is empty` : `\`${show(value, 32)}\` is not a number (\`${tag}\` has type \`f\`)`, { hint });
    } else if (type === 'H') {
      const at = value.search(/[^0-9A-Fa-f]/);
      if (at >= 0) ctx.report(S.auxValueInvalid, v + at, v + at + 1, `hex value of \`${tag}\` contains \`${show(value[at]!)}\`, which is not a hexadecimal digit`, { hint: `an \`H\` value is pairs of the digits 0-9 and A-F; use \`${tag}:Z:\` for text` });
      else ctx.report(S.auxValueInvalid, v, e, `hex value of \`${tag}\` has ${value.length} digits; a byte array needs an even number`, { hint: `each byte is two digits: a digit is missing, or the value should start with 0 (\`0${show(value, 24)}\`)` });
    } else {
      ctx.report(S.auxValueInvalid, Math.max(p, v - 1), Math.max(e, v), `array value of \`${tag}\` has no element type`, { hint: 'a `B` value starts with one of `c C s S i I f`, e.g. `B:i,1,2,3`; an empty array is written `B:i`' });
    }
  }
}

const RE_ALIGNMENT = /^[^\t]+\t\d+\t[^\t]+\t\d+\t\d+\t(?:\*|(?:\d+[MIDNSHP=X])+)\t[^\t]+\t\d+\t-?\d+\t[^\t]+\t[^\t]+(?:\t|$)/;

export const sam: FormatDef = {
  id: 'sam',
  name: 'SAM',
  description: 'Sequence Alignment/Map 1.6 (text)',
  extensions: ['.sam'],
  // A blank line is not ignorable in SAM: samtools parses it as an alignment and fails, so the validator must see every one.
  blankLinesAreData: true,
  rules: Object.values(S),
  sniff(head) {
    let score = 0;
    for (const l of head) {
      if (l === '') continue;
      if (l[0] !== '@') return RE_ALIGNMENT.test(l) ? Math.max(score, 0.85) : score;
      if (/^@(?:HD\tVN:|SQ\tSN:|RG\tID:|PG\tID:)/.test(l)) return 0.95;
      if (/^@(?:HD|SQ|RG|PG)\t[A-Za-z][A-Za-z0-9]:/.test(l)) score = 0.9;
      else if (!/^@CO(?:\t|$)/.test(l)) return score;
    }
    return score;
  },
  create() { return new SamValidator(); },
};
