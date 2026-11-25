import { LineSplitter, codePointIndex, decodeLatin1, decodeUtf8 } from './reader.ts';
import type { Context, Diagnostic, FormatDef, Level, Line, LintOptions, LintResult, Profile, ReportExtra, RuleMeta, Severity, Validator } from './types.ts';
import { T, scanUnusualBytes } from '../formats/text.ts';
import { plural } from './util.ts';

const HEAD_BYTES = 1 << 16;
/** Longest line kept in memory for formats that are checked a whole line at a time. */
const MAX_LINE = 1 << 27;

/** Bytes that are fine anywhere in a text line: tab and printable ASCII. */
const UNUSUAL = new Uint8Array(256);
for (let i = 0; i < 256; i++) UNUSUAL[i] = i === 9 || (i >= 0x20 && i < 0x7f) ? 0 : 1;

const COMPRESSION_SUFFIX = /\.(gz|bgz|bgzf)$/i;

/** Signatures of things that are not text. */
function binaryKind(b: Uint8Array): string | null {
  const at = (i: number) => b[i] ?? -1;
  const starts = (...sig: number[]) => sig.every((v, i) => at(i) === v);
  if (starts(0x42, 0x41, 0x4d, 0x01)) return 'BAM';
  if (starts(0x42, 0x43, 0x46, 0x02)) return 'BCF';
  if (starts(0x43, 0x52, 0x41, 0x4d)) return 'CRAM';
  if (starts(0x6c, 0x1b, 0x01) || starts(0x6c, 0x1b, 0x00)) return 'PLINK binary genotype (.bed)';
  if (starts(0x1f, 0x8b)) return 'gzip';
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'ZIP';
  if (starts(0x42, 0x5a, 0x68)) return 'bzip2';
  if (starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'xz';
  if (starts(0x28, 0xb5, 0x2f, 0xfd)) return 'Zstandard';
  if (starts(0x89, 0x48, 0x44, 0x46)) return 'HDF5';
  if (starts(0x53, 0x51, 0x4c, 0x69, 0x74, 0x65)) return 'SQLite';
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'PDF';
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) return 'legacy Microsoft Office';
  return null;
}

const BINARY_HINT: Record<string, string> = {
  BAM: 'convert to text first: `samtools view -h in.bam | biolint --type sam -`',
  CRAM: 'convert to text first: `samtools view -h in.cram | biolint --type sam -`',
  BCF: 'convert to text first: `bcftools view in.bcf | biolint --type vcf -`',
  'PLINK binary genotype (.bed)': 'PLINK\'s `.bed` is a binary genotype matrix that only shares its extension with the UCSC BED interval format; check it with `plink --bfile <prefix> --validate`',
  gzip: 'the data is still gzip-compressed after decompression: it was compressed twice; run `gunzip` once more',
  ZIP: 'unzip the archive and check the files inside (an .xlsx file is a ZIP archive: export the sheet as tab-separated text)',
  bzip2: 'decompress first: `bzcat file | biolint --type <format> -`',
  xz: 'decompress first: `xzcat file | biolint --type <format> -`',
  Zstandard: 'decompress first: `zstdcat file | biolint --type <format> -`',
};

class LineImpl implements Line {
  no = 0;
  bytes: Uint8Array = new Uint8Array(0);
  offset = 0;
  partial = false;
  continued = false;
  private cache: string | null = null;
  get text(): string {
    if (this.cache === null) this.cache = decodeLatin1(this.bytes);
    return this.cache;
  }
  reset(): void { this.cache = null; }
}

interface RuleState { count: number; shown: number; severity: Severity; fixable: boolean }

/**
 * Incremental linter for one file: feed decompressed bytes with `push`, then call `end`.
 * Memory use is bounded by the longest line and by the number of printed diagnostics.
 */
export class Linter {
  private readonly opts: LintOptions;
  private readonly formats: readonly FormatDef[];
  private readonly profile: Profile;
  private readonly maxPerRule: number;
  private readonly filename: string;

  private head: Uint8Array[] | null = [];
  private headLen = 0;
  private splitter: LineSplitter | null = null;
  private format: FormatDef | null = null;
  private formatSource: LintResult['formatSource'] = 'none';
  private validator: Validator | null = null;
  private ctx!: Context;
  private stopped = false;

  private readonly line = new LineImpl();
  private pieceBase = 0;        // bytes of the current physical line delivered in earlier pieces
  private lineAscii = true;
  private skippingLongLine = false;
  private lines = 0;
  private bytes = 0;
  private crlfLines = 0;
  private lfLines = 0;
  private sawContent = false;
  private pendingBlank = 0;     // empty lines seen since the last non-empty line

  private readonly diagnostics: Diagnostic[] = [];
  private readonly ruleState = new Map<string, RuleState>();
  private readonly levelCache = new Map<string, Level>();
  private readonly counts = { error: 0, warning: 0, info: 0 };
  private readonly stats: Record<string, number | string> = {};

  constructor(formats: readonly FormatDef[], opts: LintOptions = {}) {
    this.formats = formats;
    this.opts = opts;
    this.profile = opts.profile ?? 'default';
    this.maxPerRule = opts.maxPerRule ?? 5;
    this.filename = opts.filename ?? '<input>';
  }

  /** Feed the next chunk of (decompressed) file content. */
  push(chunk: Uint8Array): void {
    if (this.stopped || chunk.length === 0) return;
    this.bytes += chunk.length;
    if (this.head) {
      this.head.push(chunk);
      this.headLen += chunk.length;
      if (this.headLen >= HEAD_BYTES) this.start();
      return;
    }
    this.splitter!.push(chunk);
  }

  private container: { kind: 'gzip' | 'bgzf'; eofMarker: boolean; error?: string; bytesOut?: number } | null = null;

  /** Tell the linter how the raw file was compressed; container-level findings are reported from `end()`. */
  setContainer(info: { kind: 'gzip' | 'bgzf'; eofMarker: boolean; error?: string }): void {
    this.container = info;
  }

  /** Report a problem about the file as a whole (used for container-level findings such as truncated gzip). */
  reportFile(rule: RuleMeta, message: string, extra?: ReportExtra): void {
    this.emit(rule, 0, -1, -1, message, extra, null);
  }

  /** Finish the file and return everything that was found. */
  end(): LintResult {
    if (this.head) this.start();
    const c = this.container;
    if (c && !this.stopped) {
      if (c.error) {
        this.emit(T.gzipTruncated, 0, -1, -1, `decompression stopped after ${this.bytes.toLocaleString('en-US')} bytes of output: ${c.error}`, {
          hint: 'the file is truncated or corrupt: copy or download it again and compare checksums; the part that could be read was still checked',
        }, null);
      } else if (c.kind === 'bgzf' && !c.eofMarker) {
        this.emit(T.bgzfNoEof, 0, -1, -1, 'the BGZF end-of-file marker is missing: the file may be truncated', {
          hint: 'regenerate the file; `bgzip -t` and `samtools quickcheck` test for this',
        }, null);
      } else if (c.kind === 'gzip' && this.format?.bgzipExpected) {
        this.emit(T.gzipNotBgzf, 0, -1, -1, `compressed with plain gzip; ${this.format.name} files are usually BGZF-compressed so they can be indexed`, {
          hint: 'recompress with `zcat file.gz | bgzip > file.bgz` before running tabix, `bcftools index` or `samtools faidx`',
        }, null);
      }
    }
    if (!this.stopped) {
      // After a decompression failure the last line is an arbitrary fragment: do not judge it.
      const unterminated = this.splitter ? this.splitter.end(!!c?.error) : false;
      if (!this.sawContent) {
        this.emit(T.emptyFile, 0, -1, -1, this.bytes === 0 ? 'the file is empty (0 bytes)' : 'the file contains only blank lines', {
          hint: 'check that the step that produced this file succeeded',
        }, null);
      } else {
        if (unterminated) {
          this.emit(this.format?.finalNewlineRequired ? T.finalNewlineRequired : T.noFinalNewline, this.lines, -1, -1, 'the last line is not terminated by a newline', {
            hint: 'append a newline; if the file should be longer, it may be truncated',
            fix: { title: 'Add a final newline', transform: 'final-newline' },
          }, null);
        }
        if (this.crlfLines > 0 && this.lfLines > 0) {
          this.emit(T.mixedLineEndings, 0, -1, -1, `${plural(this.crlfLines, 'line')} end with CRLF and ${plural(this.lfLines, 'line')} end with LF`, {
            hint: 'normalise to LF with `biolint --fix` or `dos2unix`',
            fix: { title: 'Convert all line endings to LF', transform: 'lf-line-endings' },
          }, null);
        }
        if (this.pendingBlank > 0) {
          const k = this.pendingBlank;
          this.emit(T.trailingBlankLines, this.lines - k + 1, -1, -1, `${plural(k, 'blank line')} at the end of the file`, {
            hint: 'delete the empty line' + (k === 1 ? '' : 's'),
            fix: { title: 'Remove trailing blank lines', transform: 'trim-trailing-blank-lines' },
          }, null);
          this.flushBlank(true);
        }
        if (this.validator) this.validator.end(this.ctx);
      }
    }
    const byRule: LintResult['byRule'] = {};
    for (const [code, st] of this.ruleState) byRule[code] = { ...st };
    this.diagnostics.sort((a, b) => (a.line || Infinity) - (b.line || Infinity) || a.column - b.column);
    return {
      filename: this.filename,
      format: this.format?.id ?? 'unknown',
      formatSource: this.formatSource,
      diagnostics: this.diagnostics,
      counts: { ...this.counts },
      byRule,
      stats: this.stats,
      lines: this.lines,
      bytes: this.bytes,
    };
  }

  // ------------------------------------------------------------------ start-up

  private start(): void {
    let head = concat(this.head!, this.headLen);
    this.head = null;
    this.ctx = this.makeContext({});

    // Encoding and container checks on the first bytes.
    if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff) || looksUtf16(head)) {
      this.emit(T.utf16, 0, -1, -1, 'the file is encoded as UTF-16; every tool expects ASCII or UTF-8', {
        hint: 're-encode with `iconv -f UTF-16 -t UTF-8 in > out` (in PowerShell, write files with `| Out-File -Encoding utf8`)',
      }, null);
      this.stopped = true;
      return;
    }
    const bin = binaryKind(head);
    if (bin) {
      const hint = BINARY_HINT[bin];
      this.emit(T.binaryData, 0, -1, -1, `this is ${/^[AEIOU]/.test(bin) ? 'an' : 'a'} ${bin} file, not text`, hint ? { hint } : undefined, null);
      this.stopped = true;
      return;
    }
    let bom = false;
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      bom = true;
      head = head.subarray(3);
    }

    this.detect(head);
    this.ctx = this.makeContext((this.format && this.opts.formatOptions?.[this.format.id]) || {});
    if (this.format) this.validator = this.format.create(this.ctx);

    this.splitter = new LineSplitter(
      (bytes, offset, crlf, partial, continued, terminated) => this.onLine(bytes, offset, crlf, partial, continued, terminated),
      this.format?.segments ? 1 << 20 : MAX_LINE,
      !this.format?.segments,
    );
    if (bom) {
      this.emit(T.utf8Bom, 1, -1, -1, 'the file starts with a UTF-8 byte-order mark (bytes EF BB BF)', {
        hint: 'remove it with `biolint --fix` or `sed -i \'1s/^\\xEF\\xBB\\xBF//\'`',
        fix: { title: 'Remove the byte-order mark', transform: 'strip-bom' },
      }, null);
    }
    if (head.length) this.splitter.push(head);
  }

  private detect(head: Uint8Array): void {
    const name = this.filename.replace(COMPRESSION_SUFFIX, '').toLowerCase();
    const byId = (id: string) => this.formats.find((f) => f.id === id) ?? null;
    if (this.opts.format) {
      this.format = byId(this.opts.format);
      this.formatSource = 'option';
      if (!this.format) {
        this.emit(T.unknownFormat, 0, -1, -1, `unknown format \`${this.opts.format}\``, { hint: `supported formats: ${this.formats.map((f) => f.id).join(', ')}` }, null);
      }
      return;
    }
    const byExt = this.formats.find((f) => f.extensions.some((e) => name.endsWith(e))) ?? null;
    const headLines = decodeLatin1(head.subarray(0, Math.min(head.length, 1 << 15))).split(/\r?\n/).slice(0, 200);
    let best: FormatDef | null = null;
    let bestScore = 0;
    for (const f of this.formats) {
      const s = f.sniff(headLines);
      if (s > bestScore) { bestScore = s; best = f; }
    }
    if (byExt) {
      const own = byExt.sniff(headLines);
      if (best && best !== byExt && bestScore >= 0.9 && own < 0.3) {
        this.format = best;
        this.formatSource = 'content';
        const ext = byExt.extensions.find((e) => name.endsWith(e))!;
        this.emit(T.extensionMismatch, 0, -1, -1, `the name ends in \`${ext}\` (${byExt.name}) but the content is ${best.name}; checking it as ${best.name}`, {
          hint: `rename the file, or pass \`--type ${byExt.id}\` to check it as ${byExt.name} anyway`,
        }, null);
      } else {
        this.format = byExt;
        this.formatSource = 'extension';
      }
      return;
    }
    if (best && bestScore >= 0.5) {
      this.format = best;
      this.formatSource = 'content';
      return;
    }
    this.emit(T.unknownFormat, 0, -1, -1, 'could not tell which format this is from its name or content; only generic text checks were run', {
      hint: `pass \`--type\` with one of: ${this.formats.map((f) => f.id).join(', ')}`,
    }, null);
  }

  // ------------------------------------------------------------------ per line

  private onLine(bytes: Uint8Array, offset: number, crlf: boolean, partial: boolean, continued: boolean, terminated: boolean): void {
    const line = this.line;
    if (!continued) {
      this.lines++;
      this.pieceBase = 0;
      this.skippingLongLine = false;
    } else {
      this.pieceBase += line.bytes.length;
    }
    line.reset();
    line.no = this.lines;
    line.bytes = bytes;
    line.offset = offset;
    line.partial = partial;
    line.continued = continued;

    if (terminated) { if (crlf) this.crlfLines++; else this.lfLines++; }
    if (crlf && this.crlfLines === 1) {
      this.emit(T.crlf, line.no, bytes.length, bytes.length + 1, 'line ends with a carriage return (Windows CRLF line ending)', {
        hint: 'convert to Unix line endings with `biolint --fix` or `dos2unix`',
        fix: { title: 'Convert line endings to LF', transform: 'lf-line-endings' },
      }, line);
    } else if (crlf) {
      this.count(T.crlf);
    }

    // One pass over the bytes to find anything that is not tab or printable ASCII.
    let unusual = false;
    const n = bytes.length;
    for (let i = 0; i < n; i++) if (UNUSUAL[bytes[i]!]) { unusual = true; break; }
    this.lineAscii = !unusual;
    if (n > 0 && !this.sawContent) {
      for (let i = 0; i < n; i++) if (bytes[i] !== 32 && bytes[i] !== 9) { this.sawContent = true; break; }
    }
    if (unusual) this.reportUnusual(line);

    if (!this.validator) return;
    if (n === 0 && !partial && !continued && terminated && !this.format!.blankLinesAreData) {
      // Held back: blank lines at the very end are reported once, not handed to the format as records.
      this.pendingBlank++;
      return;
    }
    if (this.pendingBlank > 0) this.flushBlank(false);
    if (!this.format!.segments && (partial || continued)) {
      if (!this.skippingLongLine) {
        this.skippingLongLine = true;
        this.emit(T.lineTooLong, line.no, -1, -1, `line is longer than ${(MAX_LINE >> 20)} MiB and was not checked`, {
          hint: 'records of this format are one per line; the file is probably missing line breaks',
        }, null);
      }
      return;
    }
    this.validator.line(line, this.ctx);
  }

  /** Deliver held-back blank lines to the validator (they were followed by content), or drop them at end of file. */
  private flushBlank(atEnd: boolean): void {
    const k = this.pendingBlank;
    this.pendingBlank = 0;
    if (atEnd) return;
    const line = this.line;
    const saved = { no: line.no, bytes: line.bytes, offset: line.offset, partial: line.partial, continued: line.continued, ascii: this.lineAscii, base: this.pieceBase };
    const empty = new Uint8Array(0);
    for (let i = k; i >= 1; i--) {
      line.reset(); line.no = saved.no - i; line.bytes = empty; line.partial = false; line.continued = false;
      this.lineAscii = true; this.pieceBase = 0;
      this.validator!.line(line, this.ctx);
    }
    line.reset(); line.no = saved.no; line.bytes = saved.bytes; line.offset = saved.offset; line.partial = saved.partial; line.continued = saved.continued;
    this.lineAscii = saved.ascii; this.pieceBase = saved.base;
  }

  private reportUnusual(line: Line): void {
    for (const f of scanUnusualBytes(line.bytes)) {
      const hex = `U+${f.codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
      if (f.kind === 'invalid-utf8') {
        this.emit(T.invalidUtf8, line.no, f.index, f.index + 1, `byte 0x${f.codePoint.toString(16).toUpperCase().padStart(2, '0')} is not valid UTF-8 here`, {
          hint: 'the file is probably in a legacy encoding; convert with `iconv -f <encoding> -t UTF-8`',
        }, line);
      } else if (f.kind === 'bare-cr') {
        this.emit(T.bareCr, line.no, f.index, f.index + 1, 'carriage return in the middle of a line', {
          hint: 'if the whole file is one line, it has classic Mac line endings: convert with `mac2unix` or `tr \'\\r\' \'\\n\'`',
        }, line);
      } else if (f.kind === 'control') {
        const what = f.codePoint === 0 ? 'NUL byte' : `control character ${hex}`;
        this.emit(T.controlCharacter, line.no, f.index, f.index + f.length, `${what} in text`, {
          hint: f.codePoint === 0 ? 'NUL bytes usually mean a binary, corrupted or partly written file' : 'remove the character',
        }, line);
      } else {
        const ascii = f.ascii === '' ? 'nothing (delete it)' : f.ascii === ' ' ? 'an ordinary space' : `\`${f.ascii}\``;
        this.emit(T.suspiciousUnicode, line.no, f.index, f.index + f.length, `${hex} ${f.name} is not the ASCII character it looks like`, {
          hint: `replace it with ${ascii}`,
          fix: { title: `Replace ${hex} with ASCII`, edits: [{ line: line.no, column: this.pieceBase + f.index + 1, endColumn: this.pieceBase + f.index + f.length + 1, text: f.ascii ?? '' }] },
        }, line);
      }
    }
  }

  // ------------------------------------------------------------------ reporting

  private level(rule: RuleMeta): Level {
    let lv = this.levelCache.get(rule.code);
    if (lv !== undefined) return lv;
    lv = this.profile === 'strict' ? rule.strict ?? rule.level : rule.level;
    const match = (list: string[] | undefined) => !!list && list.some((p) => {
      const q = p.toLowerCase();
      return rule.code.toLowerCase().startsWith(q) || rule.name === q || rule.format === q;
    });
    if (this.opts.select && this.opts.select.length && !match(this.opts.select)) lv = 'off';
    if (match(this.opts.ignore)) lv = 'off';
    this.levelCache.set(rule.code, lv);
    return lv;
  }

  private count(rule: RuleMeta): void {
    const lv = this.level(rule);
    if (lv === 'off') return;
    const st = this.ruleState.get(rule.code);
    if (st) st.count++;
    this.counts[lv]++;
  }

  private emit(rule: RuleMeta, lineNo: number, col: number, endCol: number, message: string, extra: ReportExtra | undefined, line: Line | null): void {
    const lv = this.level(rule);
    if (lv === 'off') return;
    let st = this.ruleState.get(rule.code);
    if (!st) { st = { count: 0, shown: 0, severity: lv, fixable: !!rule.fixable }; this.ruleState.set(rule.code, st); }
    st.count++;
    this.counts[lv]++;
    const cap = rule.maxShown ?? this.maxPerRule;
    if (cap > 0 && st.shown >= cap) return;
    st.shown++;

    const d: Diagnostic = { code: rule.code, name: rule.name, severity: lv, message, line: lineNo, column: 0, endColumn: 0, byteColumn: 0 };
    const spec = extra?.spec ?? rule.spec;
    if (spec) d.spec = spec;
    if (extra?.hint) d.hint = extra.hint;
    if (extra?.notes?.length) d.notes = extra.notes;
    if (extra?.fix) d.fix = extra.fix;
    if (line) {
      const b = line.bytes;
      const whole = col < 0;
      const c0 = whole ? 0 : Math.min(col, b.length);
      const c1 = whole ? b.length : Math.max(c0, Math.min(endCol, b.length + 1));
      const ascii = this.lineAscii;
      d.byteColumn = this.pieceBase + c0 + 1;
      d.column = this.pieceBase + (ascii ? c0 : codePointIndex(b, c0)) + 1;
      d.endColumn = this.pieceBase + (ascii ? c1 : codePointIndex(b, c1)) + 1;
      if (whole && b.length === 0) { d.column = 1; d.endColumn = 1; d.byteColumn = 1; }
      // Keep a window of the line for display.
      const WINDOW = 160;
      let ws = 0, we = b.length;
      if (b.length > WINDOW) {
        ws = Math.max(0, Math.min(c0 - 50, b.length - WINDOW));
        we = Math.min(b.length, ws + WINDOW);
        while (ws > 0 && ws < b.length && (b[ws]! & 0xc0) === 0x80) ws++;
        while (we < b.length && (b[we]! & 0xc0) === 0x80) we++;
      }
      const sub = b.subarray(ws, we);
      const cs = Math.max(c0, ws), ce = Math.min(Math.max(c1, cs), we + 1);
      d.excerpt = {
        text: decodeUtf8(sub),
        column: (ascii ? cs - ws : codePointIndex(sub, cs - ws)) + 1,
        endColumn: (ascii ? ce - ws : codePointIndex(sub, ce - ws)) + 1,
        clippedStart: ws > 0,
        clippedEnd: we < b.length,
      };
    }
    this.diagnostics.push(d);
  }

  private makeContext(options: Record<string, unknown>): Context {
    const self = this;
    return {
      profile: this.profile,
      filename: this.filename,
      options,
      report(rule, column, endColumn, message, extra) { self.emit(rule, self.line.no, column, endColumn, message, extra, self.line); },
      reportAt(rule, lineNo, message, extra) { self.emit(rule, lineNo, -1, -1, message, extra, null); },
      enabled(rule) { return self.level(rule) !== 'off'; },
      stat(key, value) { self.stats[key] = value; },
    };
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** UTF-16 without a byte-order mark: ASCII text shows up as a NUL in every other byte. */
function looksUtf16(b: Uint8Array): boolean {
  const n = Math.min(b.length, 64) & ~1;
  if (n < 8) return false;
  let even = 0, odd = 0;
  for (let i = 0; i < n; i += 2) { if (b[i] === 0) even++; if (b[i + 1] === 0) odd++; }
  const half = n / 2;
  return (even === half && odd === 0) || (odd === half && even === 0);
}
