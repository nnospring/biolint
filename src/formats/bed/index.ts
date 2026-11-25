// BED validator (GA4GH BED v1.0, with the UCSC and ENCODE conventions that real files follow).
//
// HOW COLUMNS ARE READ (the BEDn+m question)
//
// A BED file has 3 to 12 standard fields, optionally followed by custom fields, and nothing in the file says
// where the standard fields end (BED v1.0 §4 lists this as information that must be supplied out-of-band).
// The validator therefore has to pick a reading, and the engine only lets it report on the line it is looking
// at, so the reading cannot wait for the whole file. The decisions:
//
//  1. The first data line fixes the number of fields F (every later line must match it, §1.5) and the first
//     reading: n standard fields followed by F−n custom ones. n is the longest run of leading columns that fit
//     the standard definitions on that line: a non-empty name, an integer score, a strand in `+-.`, thick
//     positions inside the feature, an itemRgb, and a block triple whose list lengths agree. So a narrowPeak
//     line (column 7 is a float) is read as BED6+4, `chr 0 100 0.25` as BED4, `chr 1 2 gene 0 exon` as BED5+1.
//     Custom fields are never checked. Whenever n < F, one `info` (BED013) says what was assumed and names the
//     value that stopped the standard reading.
//
//  2. Later lines can only narrow the reading, never widen it. A value that does not fit standard column k is
//     an error (or warning, by rule) only when the reading is *corroborated*: some column at or right of k has
//     shown a value that a custom column would not show by accident, namely a `+`/`-` strand, a thick pair
//     inside the feature, an R,G,B triple, or a consistent block triple. Since "the order is binding" (§1.5),
//     such a column proves that everything left of it is standard. Without corroboration the default profile
//     narrows the reading to k−1 standard fields and says so in an `info`; it does not guess that a float in
//     the last column of a five-column file is a bad score rather than a custom value.
//     Consequence: a 5-column file whose column 5 is `0, 0, 0.37` is BED4+1, not a BED5 with an error.
//
//  3. An empty value is treated like any other value that does not fit: custom fields may be empty in a
//     tab-separated file (§1.10), so `chr 1 2 a 5` followed by `chr 3 4 b <empty>` is a legal BED4+1. In a
//     corroborated column, and in the strict profile, it is an error (§1.5: a BED field filled on one line must
//     not be empty on another).
//
//  4. The strict profile does not narrow after the first data line: every later line must fit the reading
//     that line established. This is a heuristic too (a file that is legitimately BED4+1 but whose first value
//     in column 5 happens to be an integer is reported), chosen because someone asking for the letter of the
//     specification wants every doubtful value shown. `--option bed.type=bed4+1` (or `bed6`, `bed3+`) replaces
//     the inference with a declaration in both profiles.
//
//  5. BED10 and BED11 are prohibited, so the block fields are all-or-nothing: the reading goes from 9 to 12.
//
// Memory is constant except for the set of chromosome names used by the sortedness check, which is capped
// (MAX_CHROMS) and dropped as soon as the check has reported or the cap is hit.
import type { Context, Fix, FormatDef, Line, ReportExtra, RuleMeta, Validator } from '../../core/types.ts';
import { plural, show } from '../../core/util.ts';
import { B } from './rules.ts';

/** Field boundaries kept per line. Only the 12 standard fields are ever inspected; the rest are counted. */
const MAXF = 16;
const TAB = 9, SP = 32, COMMA = 44, PLUS = 43, MINUS = 45, DOT = 46, HASH = 35;
const U32_MAX = 4294967295;
const U64_MAX = 18446744073709551615n;
const MAX_CHROMS = 100_000;
const FIELD = ['', 'chrom', 'chromStart', 'chromEnd', 'name', 'score', 'strand', 'thickStart', 'thickEnd', 'itemRgb', 'blockCount', 'blockSizes', 'blockStarts'];
const EXPECTS = ['', '', '', '', 'a non-empty text', 'an integer from 0 to 1000', '`+`, `-` or `.`', 'an integer between chromStart and chromEnd', 'an integer between thickStart and chromEnd',
  '`0` or three comma-separated numbers from 0 to 255', 'a block count followed by two comma-separated lists of that length', 'a comma-separated list of integers', 'a comma-separated list of integers'];
const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const RE_EXCEL_DATE = new RegExp(`^(?:(?:[1-9]|[12]\\d|3[01])-(?:${MONTHS})|(?:${MONTHS})-\\d\\d|\\d\\.\\d\\dE\\+\\d\\d)$`);
const RE_HEADER_START = /^(?:chrom[_ ]?start|start|begin|pos|position|start[_ ]?pos(?:ition)?|txstart|left)$/i;
const RE_HEADER_END = /^(?:chrom[_ ]?end|end|stop|end[_ ]?pos(?:ition)?|txend|right)$/i;
const RE_CHROM = /^[A-Za-z0-9_]+$/;
const RE_CHR_STYLE = /^chr(?:[1-9]\d?|X|Y|M|MT)$/i;
const RE_BARE_STYLE = /^(?:[1-9]\d?|X|Y|MT|M)$/;
/** Track types whose data lines are not BED-like at all. */
const RE_NOT_BED_TRACK = /^(?:wiggle_0|wig|bigWig|bigBed|bam|cram|vcfTabix|vcf|maf|gff|gtf|psl|bigPsl|hic|interact)$/i;

/** Plain run of digits as a number; −1 when it is anything else or too long to be exact (16+ digits). */
function uint(b: Uint8Array, s: number, e: number): number {
  const n = e - s;
  if (n <= 0 || n > 15) return -1;
  let v = 0;
  for (let i = s; i < e; i++) {
    const d = b[i]! - 48;
    if (d >>> 0 > 9) return -1;
    v = v * 10 + d;
  }
  return v;
}

/** itemRgb: 0 = the single `0`, 1 = a valid R,G,B triple, −1 = anything else. */
function rgbKind(b: Uint8Array, s: number, e: number): number {
  if (e - s === 1) return b[s] === 48 ? 0 : -1;
  let parts = 0, v = 0, digits = 0;
  for (let i = s; i < e; i++) {
    const c = b[i]!;
    if (c === COMMA) {
      if (digits === 0 || v > 255) return -1;
      parts++; v = 0; digits = 0;
    } else {
      const d = c - 48;
      if (d >>> 0 > 9 || digits > 8) return -1;
      v = v * 10 + d; digits++;
    }
  }
  return digits > 0 && v <= 255 && parts === 2 ? 1 : -1;
}

/** Number of entries in a list of non-negative integers (`1,2,3` or `1,2,3,`); −1 when it is not one. */
function listCount(b: Uint8Array, s: number, e: number): number {
  if (e <= s) return -1;
  let n = 0, digits = 0;
  for (let i = s; i < e; i++) {
    const c = b[i]!;
    if (c === COMMA) {
      if (digits === 0) return -1;
      n++; digits = 0;
    } else if ((c - 48) >>> 0 > 9) return -1;
    else digits++;
  }
  return digits > 0 ? n + 1 : n;
}

function startsWithWord(b: Uint8Array, word: string): boolean {
  const n = word.length;
  if (b.length < n) return false;
  for (let i = 0; i < n; i++) if (b[i] !== word.charCodeAt(i)) return false;
  return b.length === n || b[n] === SP || b[n] === TAB;
}

/** Why a value is not a plain non-negative integer, and what to do about it. */
function explainNumber(v: string, field: string): { what: string; hint: string } {
  if (v === '') return { what: 'is empty', hint: `every line needs a ${field}; check for two tabs in a row` };
  if (/^-\d+$/.test(v)) {
    return { what: 'is negative', hint: 'BED coordinates start at 0. A negative value usually comes from subtracting a flank near the start of a chromosome: clamp it to `0` (`bedtools slop` and `bedtools flank` do this when given a genome file)' };
  }
  if (/^\+\d+$/.test(v)) return { what: 'has a plus sign', hint: `write \`${v.slice(1)}\`` };
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(v)) {
    const x = Number(v);
    const fixed = Number.isSafeInteger(x) && x >= 0 ? `write \`${x}\`; ` : '';
    return { what: 'is in scientific notation', hint: `${fixed}R writes round numbers this way (\`1e+05\` for 100000): set \`options(scipen = 999)\` before \`write.table\`, or use \`format(x, scientific = FALSE)\`. Spreadsheets do the same to large numbers: format the column as a number without exponent` };
  }
  if (/^\d{1,3}(?:[,.' _]\d{3})+$/.test(v) && !/^\d+\.\d{3}$/.test(v)) return { what: 'contains thousands separators', hint: `write \`${v.replace(/\D/g, '')}\`: digits only` };
  if (/^\d+\.0*$/.test(v)) return { what: 'has a decimal point', hint: `write \`${v.replace(/\..*$/, '')}\`; a numeric column was saved as floating point (in R use \`as.integer\`, in pandas \`astype(int)\`)` };
  if (/^\d+[.,]\d+$/.test(v)) return { what: 'is not a whole number', hint: 'positions are whole numbers of bases; round or truncate the value' };
  if (/^["'].*["']$/.test(v) || /^["']/.test(v) || /["']$/.test(v)) return { what: 'has a quotation mark', hint: 'BED has no quoting; remove the quotes (in R: `write.table(..., quote = FALSE)`)' };
  if (/^(?:na|nan|n\/a|null|none|\.|-)$/i.test(v)) return { what: 'is a missing-value marker', hint: `a ${field} cannot be missing: remove the line or fill in the position` };
  if (/^0x[0-9a-f]+$/i.test(v)) return { what: 'is hexadecimal', hint: `write it in decimal: \`${Number(v)}\`` };
  if (/^\d+ +\d+/.test(v)) return { what: 'contains a space', hint: 'two values are separated by a space instead of a tab' };
  if (/^\d+$/.test(v)) return { what: 'is larger than 2^64−1', hint: 'no chromosome is that long: the number is corrupted' };
  return { what: 'is not a number', hint: `a ${field} is written with digits only` };
}

class BedValidator implements Validator {
  private readonly fs = new Int32Array(MAXF + 1);
  private readonly fe = new Int32Array(MAXF + 1);

  // ---- per track (reset by a `track` line)
  private F = 0;               // fields per data line; 0 until the first data line
  private firstLine = 0;       // line that fixed F
  private tabMode = true;      // the file separates fields with single tabs
  private inferred = false;    // n has been chosen
  private inferLine = 0;
  private n = 3;               // leading columns read as standard fields
  private firm = 0;            // columns 1..firm are corroborated as standard
  private inferring = false;
  private narrowedAt = 0;      // column that stopped the reading during inference
  private dataSeen = false;
  private skipTrack = false;   // inside a track whose type is not BED-like

  // ---- per file
  private silent = false;
  private features = 0;
  private readonly forced: number;      // standard fields declared with bed.type, or 0
  private readonly forcedTotal: number; // total fields declared with bed.type, or 0
  private readonly strict: boolean;
  private noted = false;
  private trailingReported = false;
  private headerChecked = false;
  private lineHasSpace = false;
  private label = '';

  // ---- chromosome bookkeeping
  private readonly pc = new Uint8Array(256);
  private pcLen = -1;
  private sawChrStyle = 0;
  private sawBareStyle = 0;
  private mixReported = false;
  private sortOn = true;
  private lastStart = -1;
  /** Names seen so far, for the "one chromosome, one block" half of the sortedness check. Capped at MAX_CHROMS. */
  private chroms: Set<string> | null = new Set();

  constructor(ctx: Context) {
    const t = ctx.options['type'];
    const m = typeof t === 'string' ? /^bed(\d{1,2})(?:(\+)(\d*))?$/i.exec(t.trim()) : null;
    let forced = 0, total = 0;
    if (m) {
      forced = Number(m[1]);
      if (forced < 3 || forced > 12 || forced === 10 || forced === 11) forced = 0;
      else if (!m[2]) total = forced;
      else if (m[3]) total = forced + Number(m[3]);
    }
    this.forced = forced;
    this.forcedTotal = total;
    this.strict = ctx.profile === 'strict';
    this.sortOn = ctx.enabled(B.notSorted);
    if (!this.sortOn) this.chroms = null;
  }

  // ------------------------------------------------------------------ dispatch

  line(l: Line, ctx: Context): void {
    if (this.silent) return;
    const b = l.bytes;
    const len = b.length;
    if (len === 0) { this.blank(ctx, false); return; }
    const c0 = b[0]!;
    if (c0 === HASH) {
      if (l.no === 1) this.foreign(l, ctx);
      return;
    }
    if ((c0 === 116 || c0 === 98) && (startsWithWord(b, 'track') || startsWithWord(b, 'browser'))) { this.track(l, ctx, c0 === 116); return; }
    if (this.skipTrack) return;
    if (!this.dataSeen && (c0 === 62 || c0 === 64 || c0 === 0x6c) && this.foreign(l, ctx)) return;

    // Split on tabs.
    const fs = this.fs, fe = this.fe;
    let nf = 0, s = 0, space = false;
    for (let i = 0; i < len; i++) {
      const c = b[i]!;
      if (c === TAB) {
        if (nf < MAXF) { fs[nf] = s; fe[nf] = i; }
        nf++; s = i + 1;
      } else if (c === SP) space = true;
    }
    if (nf < MAXF) { fs[nf] = s; fe[nf] = len; }
    nf++;

    if (c0 === SP || c0 === TAB) {
      let i = 0;
      while (i < len && (b[i] === SP || b[i] === TAB)) i++;
      if (i === len) { this.blank(ctx, true); return; }
      ctx.report(B.leadingWhitespace, 0, i, b[i] === HASH ? 'whitespace before `#`: this line is not a comment' : `line starts with ${c0 === TAB ? 'a tab' : 'a space'}, so the chromosome name is empty`, {
        hint: 'delete the whitespace at the start of the line',
      });
      return;
    }
    this.lineHasSpace = space;

    if (this.F === 0) {
      nf = this.first(l, ctx, nf, space);
    } else if (this.tabMode) {
      if (space || nf !== this.F) nf = this.reconcile(l, ctx, nf);
    } else {
      nf = this.spaceLine(l, ctx);
    }
    if (nf < 0) return;
    this.features++;
    this.dataSeen = true;

    // ---- chrom
    const cs = fs[0]!, ce = fe[0]!;
    const clen = ce - cs;
    let same = clen === this.pcLen;
    if (same) {
      const pc = this.pc;
      for (let i = 0; i < clen; i++) if (pc[i] !== b[cs + i]) { same = false; break; }
    }
    if (!same && !this.newChrom(l, ctx, cs, ce)) return;

    // ---- chromStart, chromEnd
    const start = uint(b, fs[1]!, fe[1]!);
    const end = uint(b, fs[2]!, fe[2]!);
    if (start < 0 || end < 0) { this.badPosition(l, ctx, start, end); return; }
    if (start > end) {
      const t = l.text;
      const one = start === end + 1;
      ctx.report(B.startAfterEnd, fs[1]!, fe[2]!, `chromStart \`${show(t.slice(fs[1]!, fe[1]!))}\` is greater than chromEnd \`${show(t.slice(fs[2]!, fe[2]!))}\``, {
        hint: one
          ? `start is exactly end + 1, which is what a zero-length feature (an insertion point) becomes when 1-based coordinates are converted by subtracting 1 from the end instead of the start; a zero-length BED feature has start equal to end: \`${end}\\t${end}\``
          : `write the smaller coordinate first (\`${end}\\t${start}\`) and put the direction in the strand column. If the coordinates came from a 1-based format (GFF, VCF, a genome browser position), remember that BED counts from 0 and excludes the end: bases 1001–5000 are \`1000\\t5000\``,
      });
      return;
    }
    if (end > U32_MAX) {
      ctx.report(B.coordinateTooLarge, fs[2]!, fe[2]!, `chromEnd \`${l.text.slice(fs[2]!, fe[2]!)}\` is larger than 4,294,967,295`, {
        hint: 'check where this number comes from: it is beyond the length of almost every known chromosome and beyond what 32-bit tools (UCSC utilities, bedtools, bigBed) can store',
      });
    }
    if (this.sortOn) {
      if (start < this.lastStart) {
        ctx.report(B.notSorted, fs[1]!, fe[1]!, `chromStart \`${start}\` is smaller than \`${this.lastStart}\` on the previous line: the file is not sorted by position`, {
          hint: 'sort with `sort -k1,1 -k2,2n -k3,3n file.bed` or `bedtools sort -i file.bed` before indexing with tabix or using `bedtools -sorted`',
        });
        this.sortOn = false; this.chroms = null;
      }
      this.lastStart = start;
    }

    // ---- optional fields
    if (!this.inferred) this.infer(l, ctx, start, end);
    else if (this.n > 3) this.optional(l, ctx, start, end);
  }

  end(ctx: Context): void {
    if (this.silent) return;
    ctx.stat('features', this.features);
    if (this.label) ctx.stat('version', this.label);
  }

  // ------------------------------------------------------------------ non-data lines

  private blank(ctx: Context, whitespace: boolean): void {
    ctx.report(B.blankLine, -1, -1, whitespace ? 'line contains only spaces or tabs' : 'blank line inside the file', {
      hint: whitespace ? 'delete the line: it looks empty, but tab-based parsers see fields in it' : 'delete the line: some tools stop reading at the first blank line',
    });
  }

  /** Recognise content that is not BED at all. Returns true (and silences the validator) when it is. */
  private foreign(l: Line, ctx: Context): boolean {
    const b = l.bytes;
    let what = '', hint = '';
    if (l.no === 1 && b[0] === 0x6c && b[1] === 0x1b && (b[2] === 0x01 || b[2] === 0x00)) {
      what = 'this is a PLINK binary genotype file (it starts with the bytes 6C 1B 01), not a UCSC BED file';
      hint = 'PLINK and UCSC both use the `.bed` extension for unrelated formats; nothing is wrong with the file, but biolint cannot check it. Validate it with `plink --bfile <prefix> --validate`';
    } else {
      const t = l.text;
      if (/^##gff-version\b/.test(t)) { what = 'the file starts with `##gff-version`: this is a GFF file, not BED'; hint = 'rename it to `.gff3`, or check it with `--type gff3`'; }
      else if (/^##fileformat=VCF/.test(t)) { what = 'the file starts with `##fileformat=VCF`: this is a VCF file, not BED'; hint = 'rename it to `.vcf`, or check it with `--type vcf`'; }
      else if (/^@(?:HD|SQ|RG|PG|CO)\t/.test(t)) { what = `the file starts with a SAM header line (\`${t.slice(0, 3)}\`): this is a SAM file, not BED`; hint = 'rename it to `.sam`, or check it with `--type sam`'; }
      else if (t.charCodeAt(0) === 62 && !t.includes('\t')) { what = 'the file starts with `>`: this is a FASTA file, not BED'; hint = 'rename it to `.fa`, or check it with `--type fasta`'; }
    }
    if (!what) return false;
    ctx.report(B.otherFormat, -1, -1, what, { hint });
    this.silent = true;
    return true;
  }

  private track(l: Line, ctx: Context, isTrack: boolean): void {
    const word = isTrack ? 'track' : 'browser';
    if (this.dataSeen) {
      ctx.report(B.trackLineMisplaced, 0, word.length, isTrack ? '`track` line after data lines: a second track starts here' : '`browser` line after data lines', {
        hint: isTrack ? 'only the UCSC Genome Browser reads files with several tracks; write each track to its own file' : 'move `browser` lines to the top of the file, or delete them',
      });
    } else {
      ctx.report(B.trackLine, 0, word.length, `\`${word}\` line: this is a UCSC track file, not plain BED`, {
        hint: `delete the line for use outside a genome browser (\`grep -v -E '^(track|browser)' file.bed\`)`,
      });
    }
    if (!isTrack) return;
    // A new track may have a different layout.
    this.F = 0; this.inferred = false; this.n = 3; this.firm = 0; this.dataSeen = false; this.pcLen = -1; this.lastStart = -1;
    if (this.sortOn) this.chroms = new Set();
    const type = /(?:^|\s)type=["']?([A-Za-z0-9_]+)/.exec(l.text)?.[1] ?? '';
    this.skipTrack = RE_NOT_BED_TRACK.test(type);
  }

  // ------------------------------------------------------------------ tokenising

  /** Split on runs of spaces and tabs (the specification's own separator). Returns the field count. */
  private ws(b: Uint8Array): number {
    const fs = this.fs, fe = this.fe;
    const len = b.length;
    let nf = 0, i = 0;
    this.oddStart = -1; this.oddEnd = -1; this.wsTrailing = -1;
    while (i < len) {
      const s = i;
      while (i < len && b[i] !== SP && b[i] !== TAB) i++;
      if (nf < MAXF) { fs[nf] = s; fe[nf] = i; }
      nf++;
      if (i >= len) break;
      const sep = i;
      while (i < len && (b[i] === SP || b[i] === TAB)) i++;
      if (i >= len) { this.wsTrailing = sep; break; }
      const single = i - sep === 1;
      if (this.oddStart < 0 && (this.tabMode ? !(single && b[sep] === TAB) : this.hasTab(b, sep, i))) { this.oddStart = sep; this.oddEnd = i; }
    }
    return nf;
  }
  private oddStart = -1;
  private oddEnd = -1;
  private wsTrailing = -1;

  private hasTab(b: Uint8Array, s: number, e: number): boolean {
    for (let i = s; i < e; i++) if (b[i] === TAB) return true;
    return false;
  }

  private describeSep(b: Uint8Array, s: number, e: number): string {
    let tabs = 0, spaces = 0;
    for (let i = s; i < e; i++) if (b[i] === TAB) tabs++; else spaces++;
    if (spaces === 0) return tabs === 2 ? 'two tabs in a row' : `${tabs} tabs in a row`;
    if (tabs === 0) return spaces === 1 ? 'a space' : `${spaces} spaces`;
    return b[s] === SP ? (b[e - 1] === SP ? 'spaces around a tab' : 'a space before the tab') : 'a space after the tab';
  }

  private retab(l: Line): string {
    const t = l.text;
    const parts: string[] = [];
    for (let i = 0; i < Math.min(this.F, MAXF); i++) parts.push(t.slice(this.fs[i]!, this.fe[i]!));
    return parts.join('\t');
  }

  /** `fixLine` is the line number when deleting the whitespace cannot change the field count, else 0. */
  private reportTrailing(ctx: Context, b: Uint8Array, at: number, fixLine = 0): void {
    const extra: ReportExtra = { hint: 'delete it; a trailing tab adds an empty last column in tools that split on tabs' };
    if (fixLine) extra.fix = { title: 'Remove the trailing whitespace', edits: [{ line: fixLine, column: at + 1, endColumn: b.length + 1, text: '' }] };
    ctx.report(B.trailingWhitespace, at, b.length, `line ends with ${b[at] === TAB && b.length - at === 1 ? 'a tab' : 'whitespace'}`, extra);
  }

  /** After `ws()`: replace every separator that is not a single tab with one. */
  private tabFix(l: Line, nf: number): Fix | undefined {
    if (nf > MAXF) return undefined;
    const b = l.bytes;
    const edits: NonNullable<Fix['edits']> = [];
    for (let i = 0; i < nf - 1; i++) {
      const a = this.fe[i]!, z = this.fs[i + 1]!;
      if (!(z - a === 1 && b[a] === TAB)) edits.push({ line: l.no, column: a + 1, endColumn: z + 1, text: '\t' });
    }
    return edits.length ? { title: 'Separate the fields with single tabs', edits } : undefined;
  }

  /** The first data line of a track: decides the separator convention and the number of fields. */
  private first(l: Line, ctx: Context, nfTab: number, space: boolean): number {
    const b = l.bytes;
    let nf = nfTab;
    this.tabMode = nfTab > 1;
    let viaWs = false;
    if (!this.tabMode || nfTab < 3 || this.edgeSpace(b, nfTab) >= 0) {
      const tab = this.tabMode;
      nf = this.ws(b);
      viaWs = true;
      if (nf < 3 && tab && nfTab > nf) { nf = this.retokenTab(b); viaWs = false; }
    }
    if (nf < 3) { this.tooFew(l, ctx, nf); return -1; }
    // A column header in place of the first feature?
    if (!this.headerChecked) {
      this.headerChecked = true;
      const t = l.text;
      const f2 = t.slice(this.fs[1]!, this.fe[1]!), f3 = t.slice(this.fs[2]!, this.fe[2]!);
      if (RE_HEADER_START.test(f2) && RE_HEADER_END.test(f3)) {
        ctx.report(B.headerLine, 0, b.length, `the first line is a column header (\`${show(f2, 20)}\`, \`${show(f3, 20)}\`), not a feature`, {
          hint: 'delete the line, or start it with `#` to make it a comment',
          fix: { title: 'Comment out the header line', edits: [{ line: l.no, column: 1, endColumn: 1, text: '#' }] },
        });
        return -1;
      }
    }
    if (viaWs) {
      if (!this.tabMode) {
        ctx.report(B.spaceSeparated, this.fe[0]!, this.fs[1]!, 'fields are separated by spaces, not tabs', {
          hint: 'convert to tabs if no value contains a space, e.g. `awk -v OFS="\\t" \'{$1=$1; print}\' file.bed`; bedtools and tabix need tabs',
        });
      } else if (this.oddStart >= 0) {
        ctx.report(B.mixedSeparators, this.oddStart, this.oddEnd, `${this.describeSep(b, this.oddStart, this.oddEnd)} between fields, while other fields on this line are separated by a single tab`, {
          hint: 'use exactly one tab between fields',
          fix: this.tabFix(l, nf),
        });
      }
      if (this.wsTrailing >= 0) this.reportTrailing(ctx, b, this.wsTrailing, l.no);
    } else if (space) this.lineHasSpace = true;
    this.F = nf;
    this.firstLine = l.no;
    if (this.forcedTotal && nf !== this.forcedTotal) {
      ctx.report(B.fieldCount, -1, -1, `line has ${plural(nf, 'field')}, but the declared layout (\`bed.type\`) has ${this.forcedTotal}`, { hint: 'correct the `bed.type` option or the file' });
    }
    if (this.tabMode && !viaWs && b[b.length - 1] === TAB && !this.trailingReported) {
      this.trailingReported = true;
      this.reportTrailing(ctx, b, b.length - 1);
    }
    return nf;
  }

  /**
   * Index of the first field with a space at its edge (tab split), or −1. Only the three mandatory fields and the
   * corroborated columns after the name are looked at: in a tab-separated file a name or a custom field may hold
   * any text, spaces included (§1.7, §1.10), so a space there is content, not a stray separator.
   */
  private edgeSpace(b: Uint8Array, nf: number): number {
    const m = Math.min(nf, this.edgeLimit());
    for (let i = 0; i < m; i++) {
      if (i === 3) continue;
      const s = this.fs[i]!, e = this.fe[i]!;
      if (e > s && (b[s] === SP || b[e - 1] === SP)) return i;
    }
    return -1;
  }

  /** Strict follows the specification's reading for every column read as standard: whitespace next to a tab separates. */
  private edgeLimit(): number {
    return this.inferred ? Math.max(3, this.strict ? this.n : Math.min(this.firm, this.n)) : 3;
  }

  private retokenTab(b: Uint8Array): number {
    const fs = this.fs, fe = this.fe;
    let nf = 0, s = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === TAB) { if (nf < MAXF) { fs[nf] = s; fe[nf] = i; } nf++; s = i + 1; }
    if (nf < MAXF) { fs[nf] = s; fe[nf] = b.length; }
    return nf + 1;
  }

  /** A line of a tab-separated file that contains a space or has the wrong number of tab-separated fields. */
  private reconcile(l: Line, ctx: Context, nfTab: number): number {
    const b = l.bytes;
    const F = this.F;
    if (nfTab === F) {
      const edge = this.edgeSpace(b, nfTab);
      if (edge < 0) return nfTab; // spaces only inside values: content, not separators
      // A space next to a tab. Under the specification's reading it is part of the separator.
      const s = this.fs[edge]!, e = this.fe[edge]!;
      if (edge === nfTab - 1 && b[e - 1] === SP && b[s] !== SP) {
        let k = e;
        while (k > s && b[k - 1] === SP) k--;
        this.reportTrailing(ctx, b, k, l.no);
        this.fe[edge] = k;
        return this.edgeSpace(b, nfTab) < 0 ? nfTab : this.reconcile(l, ctx, nfTab);
      }
      // Trim every standard field so that the values can still be checked, and offer the same as a repair.
      const edits: NonNullable<Fix['edits']> = [];
      for (let i = 0; i < Math.min(nfTab, this.edgeLimit()); i++) {
        if (i === 3) continue;
        let a = this.fs[i]!, z = this.fe[i]!;
        const a0 = a, z0 = z;
        while (a < z && b[a] === SP) a++;
        while (z > a && b[z - 1] === SP) z--;
        if (a > a0) edits.push({ line: l.no, column: a0 + 1, endColumn: a + 1, text: '' });
        if (z < z0) edits.push({ line: l.no, column: z + 1, endColumn: z0 + 1, text: '' });
        this.fs[i] = a; this.fe[i] = z;
      }
      const atStart = b[s] === SP;
      let from = atStart ? s : e, to = atStart ? s : e;
      if (atStart) { while (to < e && b[to] === SP) to++; from = s - 1; } else { while (from > s && b[from - 1] === SP) from--; to = e + 1; }
      ctx.report(B.mixedSeparators, Math.max(from, 0), Math.min(to, b.length), `${this.describeSep(b, Math.max(from, 0), Math.min(to, b.length))} between fields ${atStart ? edge : edge + 1} and ${atStart ? edge + 1 : edge + 2}`, {
        hint: 'remove the space: tab-based tools take it as part of the value',
        fix: { title: 'Remove the spaces next to tabs', edits },
      });
      return nfTab;
    }
    const lastEmpty = b[b.length - 1] === TAB;
    const nf = this.ws(b);
    if (nf === F) {
      if (this.oddStart >= 0) {
        const allSpaces = nfTab === 1;
        ctx.report(B.mixedSeparators, this.oddStart, this.oddEnd,
          allSpaces ? `this line is separated by spaces; the lines before it (from line ${this.firstLine}) use tabs` : `${this.describeSep(b, this.oddStart, this.oddEnd)} between fields, where the rest of the file has a single tab`, {
            hint: 'use exactly one tab between fields' + (allSpaces ? `: \`${show(this.retab(l), 60)}\`` : ''),
            fix: this.tabFix(l, nf),
          });
      }
      if (this.wsTrailing >= 0) this.reportTrailing(ctx, b, this.wsTrailing, l.no);
      return nf;
    }
    this.retokenTab(b);
    this.wrongCount(l, ctx, nfTab, lastEmpty);
    return -1;
  }

  /** A line of a space-separated file. */
  private spaceLine(l: Line, ctx: Context): number {
    const b = l.bytes;
    const nf = this.ws(b);
    if (nf !== this.F) { this.wrongCount(l, ctx, nf, false); return -1; }
    if (this.oddStart >= 0) {
      ctx.report(B.mixedSeparators, this.oddStart, this.oddEnd, `a tab between fields, while the file (from line ${this.firstLine}) is separated by spaces`, {
        hint: 'use one separator throughout, preferably a single tab',
      });
    }
    if (this.wsTrailing >= 0) this.reportTrailing(ctx, b, this.wsTrailing, l.no);
    return nf;
  }

  private tooFew(l: Line, ctx: Context, nf: number): void {
    const t = l.text;
    let hint = 'a BED line is `chrom<TAB>chromStart<TAB>chromEnd`, optionally followed by more fields';
    const region = /^([^\s:]+):([\d,]+)(?:-|\.\.)([\d,]+)$/.exec(t);
    if (region) {
      const a = Number(region[2]!.replace(/,/g, '')), z = region[3]!.replace(/,/g, '');
      hint = `this is a region string, which counts from 1; the same interval in BED is \`${show(region[1]!)}\\t${Math.max(a - 1, 0)}\\t${z}\``;
    } else if ((t.match(/,/g)?.length ?? 0) >= 2) hint = 'the file is comma-separated (CSV); BED needs tabs: export as tab-separated text, or `tr \',\' \'\\t\' < file.csv > file.bed` if no value contains a comma';
    else if ((t.match(/;/g)?.length ?? 0) >= 2) hint = 'the file is semicolon-separated; BED needs tabs: export as tab-separated text';
    else if ((t.match(/\|/g)?.length ?? 0) >= 2) hint = 'the file is separated by `|`; BED needs tabs';
    ctx.report(B.tooFewFields, -1, -1, `line has ${plural(nf, 'field')}; a BED line needs at least 3 (chrom, chromStart, chromEnd)`, { hint });
  }

  private wrongCount(l: Line, ctx: Context, nf: number, trailingTab: boolean): void {
    const F = this.F;
    const b = l.bytes;
    let hint = 'every data line must have the same number of fields';
    let col = -1, endCol = -1;
    if (trailingTab && nf === F + 1) { hint = 'the line ends with a tab, which adds an empty field: delete it'; col = b.length - 1; endCol = b.length; }
    else if (nf > F) {
      hint = `remove the extra ${nf - F === 1 ? 'field' : 'fields'}, or check for a tab inside a value`;
      if (F < MAXF) { col = this.fe[F - 1]!; endCol = b.length; }
    } else if (nf < 3) hint = 'this line is not separated like the others; check for spaces or commas where tabs should be';
    else hint = 'a value is missing: write `.` (or `0` for a score) rather than leaving a field out; if two files with different layouts were joined, split them again';
    ctx.report(B.fieldCount, col, endCol, `line has ${plural(nf, 'field')}, but line ${this.firstLine} has ${F}`, { hint, notes: [`the first data line (line ${this.firstLine}) sets the number of fields`] });
  }

  // ------------------------------------------------------------------ chrom, positions

  /** Checks done once per run of lines with the same chromosome. Returns false when the line should be skipped. */
  private newChrom(l: Line, ctx: Context, cs: number, ce: number): boolean {
    const b = l.bytes;
    const clen = ce - cs;
    if (clen === 0) {
      ctx.report(B.emptyField, cs, cs + 1, 'chrom is empty', { hint: 'every line starts with the chromosome name' });
      return false;
    }
    const name = l.text.slice(cs, ce);
    const q = b[cs];
    if (q === 34 || q === 39) {
      ctx.report(B.quotedField, cs, ce, `chrom \`${show(name)}\` starts with a quotation mark`, {
        hint: `BED has no quoting, so the quotes become part of the name: write \`${show(name.replace(/^["']|["']$/g, ''))}\`. In R use \`write.table(..., quote = FALSE)\`; from a spreadsheet, export as tab-separated text`,
      });
      this.pcLen = -1;
      return false;
    }
    if (ctx.enabled(B.chromName)) {
      if (clen > 255) ctx.report(B.chromName, cs, ce, `chrom is ${clen} characters long; the limit is 255`);
      else if (!RE_CHROM.test(name)) {
        const at = name.search(/[^A-Za-z0-9_]/);
        ctx.report(B.chromName, cs + at, cs + at + 1, `chrom \`${show(name)}\` contains \`${show(name[at]!)}\`; the specification allows only letters, digits and \`_\``, {
          hint: 'most tools accept such names; the restriction exists for portability and is only enforced in the strict profile',
        });
      }
    }
    if (!this.mixReported) {
      if (!this.sawChrStyle && RE_CHR_STYLE.test(name)) this.sawChrStyle = l.no;
      else if (!this.sawBareStyle && RE_BARE_STYLE.test(name)) this.sawBareStyle = l.no;
      if (this.sawChrStyle && this.sawBareStyle) {
        this.mixReported = true;
        const other = Math.min(this.sawChrStyle, this.sawBareStyle);
        ctx.report(B.chromNamingMixed, cs, ce, `chrom \`${show(name)}\` is ${RE_BARE_STYLE.test(name) ? 'written without `chr`' : 'written with `chr`'}, but line ${other} uses the other style`, {
          hint: 'tools treat `chr1` and `1` as different sequences; use the naming of your reference genome throughout (`sed \'s/^chr//\'` removes the prefix, `sed \'/^[^#]/s/^/chr/\'` adds it)',
          notes: [`first name in the other style is on line ${other}`],
        });
      }
    }
    if (this.sortOn && this.chroms) {
      if (this.chroms.has(name)) {
        ctx.report(B.notSorted, cs, ce, `features on \`${show(name)}\` are not together: other chromosomes come between them`, {
          hint: 'sort with `sort -k1,1 -k2,2n -k3,3n file.bed` or `bedtools sort -i file.bed` before indexing with tabix or using `bedtools -sorted`',
        });
        this.sortOn = false; this.chroms = null;
      } else if (this.chroms.size >= MAX_CHROMS) this.chroms = null; // too many names to track: keep only the position check
      else this.chroms.add(name);
    }
    this.lastStart = -1;
    if (clen <= 256) { this.pc.set(b.subarray(cs, ce)); this.pcLen = clen; } else this.pcLen = -1;
    return true;
  }

  /** chromStart or chromEnd is not a short run of digits. */
  private badPosition(l: Line, ctx: Context, start: number, end: number): void {
    const t = l.text;
    const fs = this.fs, fe = this.fe;
    let big = false;
    if (this.features === 1 && start < 0 && end < 0) {
      // Words in both position columns of the very first line: column titles.
      const f2 = t.slice(fs[1]!, fe[1]!), f3 = t.slice(fs[2]!, fe[2]!);
      if (/^[A-Za-z][A-Za-z_. ]*$/.test(f2) && /^[A-Za-z][A-Za-z_. ]*$/.test(f3) && !/^(?:na|nan|null|none)$/i.test(f2)) {
        ctx.report(B.headerLine, 0, l.bytes.length, `the first line is a column header (\`${show(f2, 20)}\`, \`${show(f3, 20)}\`), not a feature`, {
          hint: 'delete the line, or start it with `#` to make it a comment',
          fix: { title: 'Comment out the header line', edits: [{ line: l.no, column: 1, endColumn: 1, text: '#' }] },
        });
        this.F = 0; this.features = 0; this.dataSeen = false; this.pcLen = -1; this.sawChrStyle = 0; this.sawBareStyle = 0;
        if (this.chroms) this.chroms.clear();
        return;
      }
    }
    for (let k = 1; k <= 2; k++) {
      if ((k === 1 ? start : end) >= 0) continue;
      const s = fs[k]!, e = fe[k]!;
      const v = t.slice(s, e);
      if (/^\d{16,}$/.test(v) && BigInt(v) <= U64_MAX) { big = true; continue; }
      const p = explainNumber(v, FIELD[k + 1]!);
      const quoted = p.what === 'has a quotation mark';
      ctx.report(quoted ? B.quotedField : v === '' ? B.emptyField : B.positionInvalid, s, Math.max(e, s + 1), v === '' ? `${FIELD[k + 1]} is empty` : `${FIELD[k + 1]} \`${show(v)}\` ${p.what}`, { hint: p.hint });
      return;
    }
    if (!big) return;
    const a = BigInt(t.slice(fs[1]!, fe[1]!)), z = BigInt(t.slice(fs[2]!, fe[2]!));
    if (a > z) {
      ctx.report(B.startAfterEnd, fs[1]!, fe[2]!, `chromStart \`${a}\` is greater than chromEnd \`${z}\``, { hint: 'write the smaller coordinate first' });
      return;
    }
    ctx.report(B.coordinateTooLarge, fs[2]!, fe[2]!, `chromEnd \`${z}\` is larger than 4,294,967,295`, {
      hint: 'check where this number comes from: it is beyond the length of almost every known chromosome and beyond what 32-bit tools (UCSC utilities, bedtools, bigBed) can store',
    });
  }

  // ------------------------------------------------------------------ the reading

  private setLabel(): void {
    this.label = this.n === this.F ? `BED${this.n}` : `BED${this.n}+${this.F - this.n}`;
  }

  /** Columns proven standard by this line alone: the rightmost column holding a value custom data would not show by accident. */
  private lineFirm(b: Uint8Array, start: number, end: number): number {
    const fs = this.fs, fe = this.fe;
    const F = this.F;
    if (F < 6) return 0;
    let f = 0;
    const st = fe[5]! - fs[5]! === 1 ? b[fs[5]!]! : 0;
    if (st === PLUS || st === MINUS) f = 6;
    if (F < 8) return f;
    const ts = uint(b, fs[6]!, fe[6]!), te = uint(b, fs[7]!, fe[7]!);
    if (ts >= 0 && te >= 0) {
      if ((f === 6 || st === DOT) && ts >= start && ts <= te && te <= end && end > 0) f = 8;
      if (F >= 9 && rgbKind(b, fs[8]!, fe[8]!) === 1) f = 9;
    }
    if (F >= 12 && this.blockTriple(b)) f = 12;
    return f;
  }

  /** True when columns 10–12 can hardly be anything but blockCount, blockSizes, blockStarts. */
  private blockTriple(b: Uint8Array): boolean {
    const fs = this.fs, fe = this.fe;
    const cnt = uint(b, fs[9]!, fe[9]!);
    const ns = listCount(b, fs[10]!, fe[10]!), nt = listCount(b, fs[11]!, fe[11]!);
    if (ns >= 2 && nt >= 2) return true;                                  // two real lists
    if (cnt >= 2) return ns === cnt || nt === cnt;                         // one list of the announced length
    if (cnt === 1) return ns === 1 && nt === 1 && b[fs[11]!] === 48 && (fe[11]! - fs[11]! === 1 || (fe[11]! - fs[11]! === 2 && b[fs[11]! + 1] === COMMA)); // 1, size, 0
    return false;
  }

  /** Choose the reading from the first data line with valid coordinates. */
  private infer(l: Line, ctx: Context, start: number, end: number): void {
    const b = l.bytes;
    const fs = this.fs, fe = this.fe;
    const F = this.F;
    const max = Math.min(F, 12);
    this.inferred = true;
    this.inferLine = l.no;
    this.narrowedAt = 0;
    if (this.forced) {
      this.n = Math.min(this.forced, max);
      if (this.n === 10 || this.n === 11) this.n = 9;
      this.firm = this.n;
      this.setLabel();
      if (this.n > 3) this.optional(l, ctx, start, end);
      return;
    }
    const firm = this.lineFirm(b, start, end);
    let n = Math.max(3, firm);
    // Extend over columns that look like the next standard field.
    while (n < max) {
      const k = n + 1;
      const s = fs[k - 1]!, e = fe[k - 1]!;
      let ok = false;
      if (k === 4) ok = e > s;
      else if (k === 5) ok = uint(b, s, e) >= 0 || (max >= 6 && this.strandLike(b) && this.numericLike(b, s, e));
      else if (k === 6) ok = this.strandLike(b);
      else if (k === 7 || k === 8) ok = uint(b, s, e) >= 0;
      else if (k === 9) ok = rgbKind(b, s, e) >= 0;
      else ok = false; // blocks are taken only when corroborated (firm = 12)
      if (!ok) break;
      n = k;
    }
    this.n = n;
    this.firm = firm;
    // Check the line; values that do not fit an uncorroborated column narrow the reading silently.
    this.inferring = true;
    if (n > 3) this.optional(l, ctx, start, end);
    this.inferring = false;
    n = this.n;
    this.setLabel();

    if ((F === 10 || F === 11) && n === 9) {
      const cnt = uint(b, fs[9]!, fe[9]!);
      // Plausible as blocks only: a count no larger than the feature, and for BED11 sizes that fit inside it.
      // (ENCODE bedMethyl is BED9+2 with a read count and a percentage in columns 10 and 11.)
      let looks = cnt >= 1 && cnt <= Math.max(end - start, 1);
      if (looks && F === 11) {
        looks = listCount(b, fs[10]!, fe[10]!) === cnt;
        let v = 0, digits = 0;
        for (let i = fs[10]!; looks && i <= fe[10]!; i++) {
          const c = i < fe[10]! ? b[i]! : COMMA;
          if (c === COMMA) { if (digits > 0 && (v < 1 || v > end - start)) looks = false; v = 0; digits = 0; } else { v = v * 10 + (c - 48); digits++; }
        }
      }
      if (looks) {
        ctx.report(B.blocksIncomplete, fs[9]!, fe[F - 1]!, `${F} fields per line, and ${F === 10 ? 'column 10 looks like a blockCount' : 'columns 10 and 11 look like blockCount and blockSizes'}: BED${F} is not allowed`, {
          hint: `${F === 10 ? 'blockSizes and blockStarts are' : 'blockStarts is'} missing: add ${F === 10 ? 'them' : 'it'} to make BED12, or drop the block ${F === 10 ? 'column' : 'columns'} to make BED9 (\`cut -f1-9\`). If these are custom columns of your own, declare that with \`--option bed.type=bed9+${F - 9}\``,
        });
        return;
      }
    }
    if (n < F) {
      const k = this.narrowedAt || n + 1;
      const kk = k > 9 && k <= 12 ? 10 : k;
      const custom = n + 1 === F ? `column ${F} is treated as a custom field` : `columns ${n + 1} to ${F} are treated as custom fields`;
      const known = n === 6 && F === 10 ? ' (the ENCODE narrowPeak layout)' : n === 6 && F === 9 ? ' (the ENCODE broadPeak layout)' : n === 12 && F === 15 ? ' (the ENCODE gappedPeak layout)' : '';
      let msg = `${F} fields per line: read as ${this.label}${known}`;
      let hint: string | undefined;
      if (kk > 12) msg += `; ${custom} and not checked`;
      else {
        const v = l.text.slice(fs[kk - 1]!, fe[kk - 1]!);
        const what = kk >= 10 ? (F >= 12 ? `columns 10 to 12 (\`${show(v, 16)}\`, …) are not a block description (${EXPECTS[10]})` : `the three block fields need 12 columns`)
          : v === '' ? `column ${kk} is empty` : `column ${kk} (\`${show(v, 24)}\`) does not fit ${FIELD[kk]} (${EXPECTS[kk]})`;
        msg += `. ${what[0]!.toUpperCase()}${what.slice(1)}, so ${custom} and not checked`;
        hint = `nothing to do if ${F - n === 1 ? 'that column holds' : 'those columns hold'} data of your own; if column ${kk} is meant to be ${kk >= 10 ? 'blockCount' : FIELD[kk]}, this value is invalid. To declare the layout yourself use \`--option bed.type=bed${n}+${F - n}\``;
      }
      ctx.report(B.customColumns, n < MAXF ? fs[n]! : -1, n < MAXF ? b.length : -1, msg, hint ? { hint } : undefined);
    }
  }

  private strandLike(b: Uint8Array): boolean {
    const s = this.fs[5]!;
    if (this.fe[5]! - s !== 1) return false;
    const c = b[s];
    return c === PLUS || c === MINUS || c === DOT;
  }

  /** A number in some other notation, or `.`: what programs put in the score column instead of an integer. */
  private numericLike(b: Uint8Array, s: number, e: number): boolean {
    if (e - s === 1 && b[s] === DOT) return true;
    let digits = 0;
    for (let i = s; i < e; i++) {
      const c = b[i]!;
      if ((c - 48) >>> 0 <= 9) digits++;
      else if (c !== DOT && c !== MINUS && c !== PLUS && c !== 101 && c !== 69) return false;
    }
    return digits > 0;
  }

  /**
   * A value does not fit standard column k. Returns true when it should be reported, false when the reading was
   * narrowed instead (the caller then stops looking at this line).
   */
  private misfit(k: number, l: Line, ctx: Context, start: number, end: number): boolean {
    if (k <= this.firm) return true;
    const lf = Math.min(this.lineFirm(l.bytes, start, end), this.n);
    if (lf > this.firm) this.firm = lf;
    if (k <= this.firm) return true;
    if (!this.inferring && ctx.profile === 'strict') return true;
    const old = this.label;
    const to = k > 9 ? 9 : k - 1;
    this.n = to;
    if (this.inferring) { this.narrowedAt = k; return false; }
    this.setLabel();
    const F = this.F;
    const s = this.fs[k - 1]!, e = this.fe[k - 1]!;
    const what = e === s ? `column ${k} is empty, which a ${FIELD[k]} cannot be` : `column ${k} (\`${show(l.text.slice(s, e), 24)}\`) does not fit ${FIELD[k]} (${EXPECTS[k]})`;
    ctx.report(B.customColumns, s, Math.max(e, s + 1), `${what}: from here on the file is read as ${this.label} instead of ${old}`, {
      hint: `${to + 1 === F ? `column ${F} is` : `columns ${to + 1} to ${F} are`} now treated as custom and not checked. If column ${k} is meant to be ${FIELD[k]}, this value is invalid; say so with \`--option bed.type=${old.toLowerCase()}\``,
      notes: [`lines ${this.inferLine} to ${l.no - 1} fit ${old}`],
    });
    return false;
  }

  /** Report a problem in an optional standard field; the first such report says how the columns are being read. */
  private opt(rule: RuleMeta, k: number, ctx: Context, col: number, endCol: number, message: string, extra: ReportExtra): void {
    if (!this.noted && !this.forced) {
      this.noted = true;
      const declare = `if column ${k} is a custom field instead, declare it with \`--option bed.type=bed${k > 9 ? 9 : k - 1}+${this.F - (k > 9 ? 9 : k - 1)}\``;
      if (this.inferring) {
        // The reading is still being worked out on this very line: say why this column counts as standard.
        (extra.notes ??= []).push(`column ${k} is read as ${FIELD[k]} because the columns to its right on this line fit the standard fields that follow it; ${declare}`);
      } else {
        const why = this.F > this.n ? `${this.F} fields per line, of which the first ${this.n} are read as standard fields` : `${this.F} fields per line, all read as standard fields`;
        (extra.notes ??= []).push(`${why} (${this.label}, inferred from line ${this.inferLine}); ${declare}`);
      }
    }
    ctx.report(rule, col, Math.max(endCol, col + 1), message, extra);
  }

  // ------------------------------------------------------------------ optional standard fields

  private optional(l: Line, ctx: Context, start: number, end: number): void {
    const b = l.bytes;
    const fs = this.fs, fe = this.fe;

    // ---- 4: name
    let s = fs[3]!, e = fe[3]!;
    const nameLen = e - s;
    if (nameLen === 0) {
      if (!this.misfit(4, l, ctx, start, end)) return;
      this.opt(B.emptyField, 4, ctx, s, s + 1, 'name is empty', { hint: 'write `.` when a feature has no name' });
    } else {
      if (nameLen >= 5 && nameLen <= 8 && (b[s + 1] === MINUS || b[s + 2] === MINUS || b[s + 3] === MINUS || b[s + 1] === DOT)) this.excelName(l, ctx, s, e);
      if (nameLen > 255 && ctx.enabled(B.nameTooLong)) this.opt(B.nameTooLong, 4, ctx, s, e, `name is ${nameLen} characters long; the limit is 255`, { hint: 'shorten the name, or move the description to a custom column after the standard ones' });
      if (this.lineHasSpace && this.tabMode) {
        for (let i = s; i < e; i++) {
          if (b[i] === SP) {
            const v = l.text.slice(s, e);
            this.opt(B.nameWhitespace, 4, ctx, i, i + 1, `name \`${show(v)}\` contains a space`, { hint: `write \`${show(v.replace(/ +/g, '_'))}\`: tools that split on any whitespace would read the name as two fields` });
            break;
          }
        }
      }
    }
    if (this.n < 5) return;

    // ---- 5: score
    s = fs[4]!; e = fe[4]!;
    const score = uint(b, s, e);
    if (score < 0 || score > 1000) {
      if (e === s) {
        if (!this.misfit(5, l, ctx, start, end)) return;
        this.opt(B.emptyField, 5, ctx, s, s + 1, 'score is empty', { hint: 'write `0` when there is no score' });
      } else {
        // A numeric value or `.` next to a strand column is a score in the wrong notation, not a custom field.
        const weak = this.n >= 6 && this.strandLike(b) && this.numericLike(b, s, e);
        if (!weak && !this.misfit(5, l, ctx, start, end)) return;
        const v = l.text.slice(s, e);
        if (v === '.') this.opt(B.scoreDot, 5, ctx, s, e, 'score is `.`', { hint: 'write `0` when there is no score' });
        else if (score > 1000) this.opt(B.scoreInvalid, 5, ctx, s, e, `score \`${v}\` is above 1000`, { hint: 'scores run from 0 to 1000: rescale, cap at `1000`, or write `0` and keep the real value in an extra column after the standard ones' });
        else if (/^-\d+$/.test(v)) this.opt(B.scoreInvalid, 5, ctx, s, e, `score \`${v}\` is negative`, { hint: 'scores run from 0 to 1000: write `0`, and keep the real value in an extra column after the standard ones' });
        else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)) this.opt(B.scoreInvalid, 5, ctx, s, e, `score \`${show(v)}\` is not a whole number`, { hint: 'a score is an integer from 0 to 1000: round it, or write `0` and keep the real value (p-value, signal, fold change) in an extra column after the standard ones' });
        else this.opt(B.scoreInvalid, 5, ctx, s, e, `score \`${show(v)}\` is not a number`, { hint: 'a score is an integer from 0 to 1000; write `0` when there is none' });
      }
    }
    if (this.n < 6) return;

    // ---- 6: strand
    s = fs[5]!; e = fe[5]!;
    const st = e - s === 1 ? b[s]! : 0;
    let strandOk = true;
    if (st === PLUS || st === MINUS) { if (this.firm < 6) this.firm = 6; }
    else if (st !== DOT) {
      strandOk = false;
      if (e === s) {
        if (!this.misfit(6, l, ctx, start, end)) return;
        this.opt(B.emptyField, 6, ctx, s, s + 1, 'strand is empty', { hint: 'write `.` when the strand is unknown' });
      } else {
        if (!this.misfit(6, l, ctx, start, end)) return;
        const v = l.text.slice(s, e);
        const lower = v.toLowerCase();
        let hint = 'write `+`, `-`, or `.` when the strand is unknown';
        if (/^(?:plus|forward|fwd|f|pos|positive|sense|\+1|1|w|watson|top)$/.test(lower)) hint = 'write `+`';
        else if (/^(?:minus|reverse|rev|r|neg|negative|antisense|-1|c|crick|bottom)$/.test(lower)) hint = 'write `-`';
        else if (/^(?:\*|\?|na|nan|none|null|unknown|0|both|n\/a)$/.test(lower)) hint = 'write `.` for an unknown or irrelevant strand' + (v === '*' ? ' (`*` is how Bioconductor GRanges objects print it; `rtracklayer::export` converts it)' : '');
        else if (/^[+\-.]\s+$|^\s+[+\-.]$/.test(v)) hint = 'remove the space next to the strand';
        this.opt(B.strandInvalid, 6, ctx, s, e, `strand \`${show(v)}\` is not \`+\`, \`-\` or \`.\``, { hint });
      }
    }
    if (this.n < 7) return;

    // ---- 7, 8: thickStart, thickEnd
    s = fs[6]!; e = fe[6]!;
    const ts = uint(b, s, e);
    let thickOk = true;
    if (ts < 0) {
      thickOk = false;
      if (!this.badThickNumber(7, l, ctx, start, end)) return;
    } else if (ts < start || ts > end) {
      thickOk = false;
      if (!this.misfit(7, l, ctx, start, end)) return;
      this.opt(B.thickOutOfRange, 7, ctx, s, e, `thickStart \`${ts}\` is ${ts < start ? `before chromStart \`${start}\`` : `after chromEnd \`${end}\``}`, {
        hint: ts < end - start && ts < start ? `thickStart is an absolute position, not an offset: did you mean \`${start + ts}\`? Use \`${start}\` (chromStart) when there is no thick part` : `use \`${start}\` (chromStart) when there is no thick part`,
      });
    }
    if (this.n >= 8) {
      s = fs[7]!; e = fe[7]!;
      const te = uint(b, s, e);
      if (te < 0) {
        thickOk = false;
        if (!this.badThickNumber(8, l, ctx, start, end)) return;
      } else if (te > end || te < start || (thickOk && te < ts)) {
        const before = thickOk && te < ts;
        thickOk = false;
        if (!this.misfit(8, l, ctx, start, end)) return;
        this.opt(B.thickOutOfRange, 8, ctx, s, e, `thickEnd \`${te}\` is ${te > end ? `after chromEnd \`${end}\`` : before ? `before thickStart \`${ts}\`` : `before chromStart \`${start}\``}`, {
          hint: `thickEnd must lie between thickStart and chromEnd; use \`${start}\` for both thick positions when there is no thick part, or \`${end}\` (chromEnd) for thickEnd when the whole feature is thick`,
        });
      } else if (thickOk && strandOk && this.firm < 8 && end > 0) this.firm = 8;
    }
    if (this.n < 9) return;

    // ---- 9: itemRgb
    s = fs[8]!; e = fe[8]!;
    const rgb = rgbKind(b, s, e);
    if (rgb === 1) { if (this.firm < 9 && thickOk) this.firm = 9; }
    else if (rgb < 0) {
      if (e === s) {
        if (!this.misfit(9, l, ctx, start, end)) return;
        this.opt(B.emptyField, 9, ctx, s, s + 1, 'itemRgb is empty', { hint: 'write `0` when there is no colour' });
      } else {
        if (!this.misfit(9, l, ctx, start, end)) return;
        const v = l.text.slice(s, e);
        let hint = 'write three numbers from 0 to 255 separated by commas, e.g. `255,0,0`, or `0` for no colour';
        const hex = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
        const parts = v.split(',');
        if (hex && /[a-f#]/i.test(v)) hint = `write the colour as decimal R,G,B: \`${parseInt(hex[1]!, 16)},${parseInt(hex[2]!, 16)},${parseInt(hex[3]!, 16)}\``;
        else if (/^\d+,\d+,\d+,$/.test(v)) hint = `remove the trailing comma: \`${v.slice(0, -1)}\``;
        else if (/^\d+( *, *\d+){2}$/.test(v) && v.includes(' ')) hint = `remove the spaces: \`${v.replace(/ /g, '')}\``;
        else if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) hint = `each value must be between 0 and 255; \`${parts.find((p) => Number(p) > 255)}\` is too large`;
        else if (/^\d+$/.test(v)) hint = 'a single number other than `0` is not a colour: write `R,G,B`, e.g. `255,0,0`';
        else if (/^[a-z]+$/i.test(v)) hint = 'colour names are not understood: write `R,G,B`, e.g. `255,0,0` for red';
        else if (/^\d+,\d+$/.test(v)) hint = 'a colour needs three values: red, green and blue';
        this.opt(B.itemRgb, 9, ctx, s, e, `itemRgb \`${show(v)}\` is not \`0\` or three numbers from 0 to 255`, { hint });
      }
    }
    if (this.n < 12) return;
    this.blocks(l, ctx, start, end);
  }

  private excelName(l: Line, ctx: Context, s: number, e: number): void {
    const v = l.text.slice(s, e);
    if (!RE_EXCEL_DATE.test(v)) return;
    let was = '';
    const dm = /^(\d+)-([A-Za-z]{3})$/.exec(v);
    if (dm) {
      const fam: Record<string, string> = { Mar: 'MARCH or MARC', Sep: 'SEPT', Dec: 'DEC', Oct: 'OCT', Feb: 'FEB', Nov: 'NOV', Apr: 'APR', Jun: 'JUN', Jan: 'JAN', May: 'MAY', Jul: 'JUL', Aug: 'AUG' };
      was = ` (probably ${fam[dm[2]!]!.split(' or ').map((f) => `\`${f}${dm[1]}\``).join(' or ')})`;
    }
    this.opt(B.nameExcelDate, 4, ctx, s, e, `name \`${v}\` looks like a gene symbol that a spreadsheet turned into ${/E\+/.test(v) ? 'a number' : 'a date'}${was}`, {
      hint: 'the original symbol cannot be recovered from this file: go back to the source and import the column as text (current HGNC symbols such as MARCHF1 and SEPTIN2 avoid the problem)',
    });
  }

  private badThickNumber(k: number, l: Line, ctx: Context, start: number, end: number): boolean {
    const s = this.fs[k - 1]!, e = this.fe[k - 1]!;
    if (e === s) {
      if (!this.misfit(k, l, ctx, start, end)) return false;
      this.opt(B.emptyField, k, ctx, s, s + 1, `${FIELD[k]} is empty`, { hint: `write \`${k === 7 ? start : end}\` (${k === 7 ? 'chromStart' : 'chromEnd'}) when the whole feature is drawn thick` });
      return true;
    }
    if (!this.misfit(k, l, ctx, start, end)) return false;
    const v = l.text.slice(s, e);
    if (/^\d{16,}$/.test(v)) { this.opt(B.thickOutOfRange, k, ctx, s, e, `${FIELD[k]} \`${show(v)}\` is after chromEnd \`${end}\``, { hint: `use \`${start}\` (chromStart) when there is no thick part` }); return true; }
    if (v === '-1') {
      this.opt(B.thickMinusOne, k, ctx, s, e, `${FIELD[k]} is \`-1\`, a convention some tools use for "no coding region"`, { hint: `write \`${start}\` (chromStart) in both thickStart and thickEnd for a feature without a thick part` });
      return true;
    }
    const p = explainNumber(v, FIELD[k]!);
    this.opt(B.thickInvalid, k, ctx, s, e, `${FIELD[k]} \`${show(v)}\` ${p.what}`, { hint: p.hint });
    return true;
  }

  // ------------------------------------------------------------------ blocks

  private blocks(l: Line, ctx: Context, start: number, end: number): void {
    const b = l.bytes;
    const fs = this.fs, fe = this.fe;
    const cnt = uint(b, fs[9]!, fe[9]!);
    if (cnt <= 0) {
      const v = l.text.slice(fs[9]!, fe[9]!);
      if (v === '') { this.opt(B.emptyField, 10, ctx, fs[9]!, fs[9]! + 1, 'blockCount is empty', { hint: 'a feature without sub-structure has one block: `1`, its length, `0`' }); return; }
      this.opt(B.blockCount, 10, ctx, fs[9]!, fe[9]!, cnt === 0 ? 'blockCount is `0`' : `blockCount \`${show(v)}\` is not a positive integer`, {
        hint: cnt === 0 ? `a feature has at least one block; for a feature without sub-structure write \`1\\t${end - start}\\t0\`` : 'blockCount is the number of entries in blockSizes and blockStarts',
      });
      return;
    }
    const ns = listCount(b, fs[10]!, fe[10]!), nt = listCount(b, fs[11]!, fe[11]!);
    for (let k = 11; k <= 12; k++) {
      if ((k === 11 ? ns : nt) >= 0) continue;
      const s = fs[k - 1]!, e = fe[k - 1]!;
      const v = l.text.slice(s, e);
      if (v === '') { this.opt(B.emptyField, k, ctx, s, s + 1, `${FIELD[k]} is empty`, { hint: `list ${plural(cnt, 'value')} separated by commas` }); return; }
      let what = 'is not a comma-separated list of integers', hint = `write ${plural(cnt, 'non-negative integer')} separated by commas, e.g. \`${k === 11 ? '567,488' : '0,3512'}\``;
      let at = v.search(/[^0-9,]/), len = 1;
      if (/-\d/.test(v)) { what = 'contains a negative number'; hint = k === 11 ? 'block sizes cannot be negative' : 'block starts are offsets from chromStart and cannot be negative; blocks are listed left to right on both strands'; at = v.indexOf('-'); }
      else if (/[ ;|:\/]/.test(v)) { what = `uses \`${show(v[v.search(/[ ;|:\/]/)]!)}\` between values`; hint = 'separate the values with commas only, without spaces'; }
      else if (/,,|^,/.test(v)) { what = 'has an empty entry'; hint = 'remove the extra comma'; at = v.search(/,,|^,/); len = v[at + 1] === ',' ? 2 : 1; }
      else if (/[eE.]/.test(v)) { what = 'contains a value that is not a whole number'; }
      if (at < 0) { at = 0; len = v.length; }
      this.opt(B.blockListMalformed, k, ctx, s + at, s + at + len, `${FIELD[k]} \`${show(v)}\` ${what}`, { hint });
      return;
    }
    if (ns !== cnt || nt !== cnt) {
      const k = ns !== cnt ? 11 : 12;
      const got = k === 11 ? ns : nt;
      let hint = `list exactly ${plural(cnt, 'value')}, or set blockCount to \`${got}\` if the lists are right`;
      if (ns === nt) hint = `blockSizes and blockStarts both have ${plural(ns, 'entry', 'entries')}: set blockCount to \`${ns}\``;
      else if (got < cnt) hint = `${FIELD[k]} looks truncated (spreadsheets and some editors cut long cells); regenerate the line from its source`;
      if (cnt > 1 && got === 1 && fe[k - 1]! - fs[k - 1]! > 3) hint = 'the commas between the values are missing';
      this.opt(B.blockListCount, k, ctx, fs[k - 1]!, fe[k - 1]!, `${FIELD[k]} has ${plural(got, 'entry', 'entries')}, but blockCount is \`${cnt}\``, { hint });
      return;
    }
    // Sizes and starts, pairwise.
    const len = end - start;
    let i = fs[10]!, j = fs[11]!;
    const ie = fe[10]!, je = fe[11]!;
    let prevEnd = 0, prevStart = -1;
    let j0 = j, j1 = j, i0 = i, i1 = i;
    for (let k = 0; k < cnt; k++) {
      let size = 0, bs = 0, c = 0;
      i0 = i;
      while (i < ie && (c = b[i]!) !== COMMA) { size = size * 10 + (c - 48); i++; }
      i1 = i; i++;
      j0 = j;
      while (j < je && (c = b[j]!) !== COMMA) { bs = bs * 10 + (c - 48); j++; }
      j1 = j; j++;
      if (k === 0) {
        if (bs !== 0) {
          // A first start that is not the smallest means the list is in the wrong order, not shifted.
          let v = 0, smaller = false;
          for (let p = j; p <= je && !smaller; p++) {
            const d = p < je ? b[p]! : COMMA;
            if (d === COMMA) { if (p > j && b[p - 1] !== COMMA && v < bs) smaller = true; v = 0; } else v = v * 10 + (d - 48);
          }
          if (smaller) {
            this.opt(B.blockOverlap, 12, ctx, fs[11]!, je, `blockStarts begins with \`${bs}\` and continues with smaller values: blocks are not in ascending order`, {
              hint: 'list blocks from left to right along the chromosome, also for features on the minus strand (reverse both lists)',
            });
            return;
          }
          this.opt(B.blockFirstStart, 12, ctx, j0, j1, `the first block starts at offset \`${bs}\`, not at chromStart`, {
            hint: bs === start ? `block starts are offsets from chromStart, not chromosome positions: subtract \`${start}\` from every entry, so the list begins with \`0\`` : 'the first entry of blockStarts must be `0`; if the feature really begins later, raise chromStart instead',
          });
          return;
        }
      } else if (bs < prevEnd) {
        const unsorted = bs < prevStart;
        this.opt(B.blockOverlap, 12, ctx, j0, j1, unsorted ? `block ${k + 1} starts at offset \`${bs}\`, before block ${k} (\`${prevStart}\`): blocks are not in ascending order` : `block ${k + 1} starts at offset \`${bs}\`, inside block ${k}, which ends at \`${prevEnd}\``, {
          hint: unsorted ? 'list blocks from left to right along the chromosome, also for features on the minus strand (reverse both lists)' : 'blocks may touch but not overlap: shorten the earlier block or move the later one',
        });
        return;
      }
      if (bs + size > len) {
        this.opt(B.blockOutsideFeature, 12, ctx, j0, j1, `block ${k + 1} ends at offset \`${bs + size}\` (start \`${bs}\` + size \`${size}\`), beyond the feature length \`${len}\``, {
          hint: bs >= start && start > 0 ? `block starts are offsets from chromStart, not chromosome positions: subtract \`${start}\` from every entry` : `the feature is ${len} bases long (chromEnd − chromStart): extend chromEnd to \`${start + bs + size}\` or correct the block`,
        });
        return;
      }
      prevStart = bs; prevEnd = bs + size;
    }
    if (prevEnd !== len) {
      this.opt(B.blockLastEnd, 12, ctx, i0, i1, `the last block ends at offset \`${prevEnd}\`, but the feature is \`${len}\` long (chromEnd − chromStart)`, {
        hint: `the last block must end exactly at chromEnd: set chromEnd to \`${start + prevEnd}\`, or the last block size to \`${len - prevStart}\``,
      });
    }
  }
}

export const bed: FormatDef = {
  id: 'bed',
  name: 'BED',
  description: 'Browser Extensible Data (BED3 to BED12, with custom columns: narrowPeak, broadPeak, bedGraph)',
  extensions: ['.bed', '.narrowpeak', '.broadpeak', '.gappedpeak', '.bedgraph'],
  bgzipExpected: true,
  rules: Object.values(B),
  sniff(head) {
    let seen = 0, good = 0, tabbed = 0;
    let track = false;
    for (const l of head) {
      if (seen >= 20) break;
      if (l === '' || l[0] === '#' || l.trim() === '') continue;
      if (/^(?:track|browser)(?:[ \t]|$)/.test(l)) { track = true; continue; }
      seen++;
      const tab = l.includes('\t');
      const f = tab ? l.split('\t') : l.trim().split(/ +/);
      if (f.length < 3 || !/^\d+$/.test(f[1]!) || !/^\d+$/.test(f[2]!) || Number(f[1]) > Number(f[2])) continue;
      // Headerless SAM with a numeric reference name also has integers in columns 2 and 3.
      if (f.length >= 11 && /^\d+$/.test(f[3]!) && /^(?:\*|(?:\d+[MIDNSHP=X])+)$/.test(f[5]!)) continue;
      good++;
      if (tab) tabbed++;
    }
    if (seen === 0) return track ? 0.5 : 0;
    if (good / seen < 0.8) return good > 0 ? 0.1 : 0;
    return track ? 0.9 : tabbed === good ? 0.8 : 0.7;
  },
  create(ctx) { return new BedValidator(ctx); },
};
