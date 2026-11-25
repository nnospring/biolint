import type { Context, FormatDef, Line, Validator } from '../../core/types.ts';
import { plural, show } from '../../core/util.ts';
import { T } from '../text.ts';
import { Q } from './rules.ts';

// ---------------------------------------------------------------------------------------------- byte classes

/** Sequence bytes: 0 = IUPAC nucleotide code or `-`, otherwise one of the classes below. */
const C_SPACE = 1, C_OTHER = 2, C_CONTROL = 4;
const SEQ = new Uint8Array(256).fill(C_OTHER);
{
  for (const ch of 'ACGTUNRYKMSWBDHV') { SEQ[ch.charCodeAt(0)] = 0; SEQ[ch.toLowerCase().charCodeAt(0)] = 0; }
  SEQ[45] = 0; // '-': "the inclusion of a gap character may make sense" (Cock et al.)
  SEQ[32] = C_SPACE; SEQ[9] = C_SPACE;
  // Control characters are reported by the engine (TXT007).
  for (let c = 0; c < 32; c++) if (c !== 9) SEQ[c] = C_CONTROL;
  SEQ[127] = C_CONTROL;
}

/** Reads per block of the name digest: `nameCheckpoints` holds the running digest after every block. */
export const NAME_BLOCK = 4096;
/** At most this many individual characters are reported per line. */
const PER_LINE = 8;

const S_TITLE = 0, S_SEQ = 1, S_PLUS = 2, S_QUAL = 3;
const SUSPECT_WAS_QUALITY = 0, SUSPECT_WAS_TITLE = 1, SUSPECT_WAS_PARTIAL_QUALITY = 2;
const SHORT_HINT = 'the record is cut short: a write was interrupted, or two writers shared the file; regenerate it and compare checksums';
const hex8 = (v: number) => (v >>> 0).toString(16).padStart(8, '0');

class FastqValidator implements Validator {
  private state = S_TITLE;
  /** After a structural error: ignore lines until the next one that starts with `@`. */
  private skipping = false;
  private reads = 0;
  private bases = 0;
  private qmin = 255;
  private qmax = 0;

  // current record
  private title = new Uint8Array(256);
  private titleLen = 0;
  private titleLine = 0;
  private lastTitleLine = 0;
  /** Whether the last line of the last complete record (its final quality line) was empty. */
  private lastQualityEmpty = false;
  private seqLen = 0;
  private seqLines = 0;
  private firstSeqLen = 0;
  private wrapLine = 0;
  private qualLen = 0;
  private qualLines = 0;
  private qualWrapLine = 0;
  private lastQualLine = 0;
  private qualTail = 0;           // length of the most recent quality line
  /** A record with wrapped sequence or quality has been seen: the file is not in plain four-line layout. */
  private wrappedSeen = false;

  // blank lines seen where a title was expected, not yet classified
  private blankCount = 0;
  private blankLine = 0;

  // a line in quality position that starts with `@` and does not complete the quality: more quality, or the next title?
  private suspect = new Uint8Array(0);
  private suspectLen = 0;
  private suspectLine = 0;

  // Running 64-bit FNV-1a digest of the normalised read names, as two unsigned 32-bit halves (no BigInt per read).
  private hi = 0xcbf29ce4;
  private lo = 0x84222325;
  private pendingHi = 0;
  private pendingLo = 0;
  /**
   * One 16-hex-digit digest per NAME_BLOCK reads. This grows with the file, by design, at 4 bytes per thousand reads
   * (400 kB for 100 million reads); it is what lets two files be compared block by block without keeping any names.
   */
  private checkpoints = '';

  // interleaved pairs: 0 = not decided, 1 = interleaved, 2 = not interleaved or no longer checked
  private interleaved = 0;
  private firstMate = 0;
  private nameHash = 0;
  private nameLen = 0;
  private prevNameHash = 0;
  private prevNameLen = 0;

  line(line: Line, ctx: Context): void {
    const b = line.bytes;
    const n = b.length;
    switch (this.state) {
      case S_TITLE:
        if (this.suspectLine > 0) {
          const was = this.resolveSuspect(n === 0 || b[0] === 64, ctx);
          if (was === SUSPECT_WAS_TITLE) { this.sequenceLine(b, n, line, ctx); return; }
          if (was === SUSPECT_WAS_PARTIAL_QUALITY) { this.qualityPosition(b, n, line, ctx); return; }
        }
        if (n === 0) { if (this.blankCount++ === 0) this.blankLine = line.no; return; }
        if (b[0] !== 64) {
          if (!this.skipping) this.reportNotTitle(b, n, line, ctx);
          this.skipping = true;
          this.blankCount = 0;
          return;
        }
        this.startRecord(b, n, line.no, ctx, true);
        return;

      case S_SEQ:
        if (n > 0 && b[0] === 64) {
          // A sequence cannot start with `@`: the previous record stopped after its title.
          this.interleaved = 2;
          ctx.report(Q.truncatedRecord, -1, -1, `a new record starts here, but ${this.name()} (line ${this.titleLine}) has only a title: its sequence, \`+\` and quality lines are missing`, {
            hint: 'lines were lost; regenerate the file or remove the incomplete record',
          });
          this.startRecord(b, n, line.no, ctx, true);
          return;
        }
        this.sequenceLine(b, n, line, ctx);
        return;

      case S_PLUS:
        if (n > 0 && b[0] === 43) {
          if (n > 1 && !this.plusMatchesTitle(b, n)) {
            // Point at the first character that differs from the title.
            let d = 1;
            while (d < n && d < this.titleLen && b[d] === this.title[d]) d++;
            const what = d >= n ? `stops short of the title \`${show(this.titleText(), 72)}\``
              : d >= this.titleLen ? `continues past the title \`${show(this.titleText(), 72)}\``
              : `differs from the title \`${show(this.titleText(), 72)}\` at character ${d + 1}`;
            ctx.report(Q.plusLineMismatch, Math.min(d, n - 1), n, `the text after \`+\`, \`${show(line.text.slice(1), 72)}\`, ${what}`, {
              hint: 'the sequence and quality may belong to different reads; if the file is otherwise sound, `seqtk seq in.fq > out.fq` rewrites it with bare `+` lines',
              notes: [`title on line ${this.titleLine}`],
            });
          }
          if (this.seqLen === 0) {
            ctx.reportAt(Q.emptyRead, line.no - 1, `${this.name()} has no bases`, {
              hint: 'drop zero-length reads when trimming (`cutadapt -m 1`, `fastp -l 1`); some aligners stop on them',
            });
          }
          if (this.seqLines > 1) {
            ctx.reportAt(Q.multiLineRecord, this.wrapLine, `the sequence of ${this.name()} continues on a second line (${plural(this.seqLines, 'line')}, ${plural(this.seqLen, 'base')})`, {
              hint: 'most tools expect four lines per record; unwrap with `seqtk seq -l0 in.fq > out.fq`',
            });
          }
          this.state = S_QUAL;
          this.qualLen = 0;
          this.qualLines = 0;
          return;
        }
        if (n > 0 && b[0] === 64) {
          this.interleaved = 2;
          const looksLikeQuality = this.seqLines === 2 && this.seqLen === 2 * this.firstSeqLen;
          ctx.report(Q.truncatedRecord, -1, -1, `a new record starts here, but ${this.name()} (line ${this.titleLine}) has no \`+\` line and no quality`, {
            hint: looksLikeQuality
              ? `line ${this.wrapLine} may be the quality string of that record; if so, only its \`+\` line is missing`
              : 'lines were lost; regenerate the file or remove the incomplete record',
          });
          this.startRecord(b, n, line.no, ctx, true);
          return;
        }
        if (n > 0 && isSequenceLike(b, n)) {
          // The format allows wrapped sequences; reported once the `+` line confirms that this is one.
          this.seqLen += n;
          if (++this.seqLines === 2) this.wrapLine = line.no;
          return;
        }
        this.interleaved = 2;
        ctx.report(Q.plusLineMissing, 0, Math.min(n, 1), n === 0
          ? `expected the \`+\` line of ${this.name()} but found an empty line`
          : `expected the \`+\` line of ${this.name()} but found \`${show(line.text, 24)}\``, {
            hint: n === this.seqLen && this.seqLines === 1
              ? 'this line has the length of the sequence, so it is probably the quality string: insert a `+` line above it'
              : 'each record is four lines: `@title`, sequence, `+`, quality',
            notes: [`record starts on line ${this.titleLine}`],
          });
        this.state = S_TITLE;
        this.skipping = true;
        return;

      default: // S_QUAL
        this.qualityPosition(b, n, line, ctx);
    }
  }

  /**
   * A line where quality is expected. Quality lines are collected until they cover the sequence, because the format
   * lets the quality wrap (independently of the sequence). The difficulty is a quality that is too short: the title
   * of the next record also starts with `@`, a valid quality character, so such a line is set aside and judged by
   * the line after it.
   */
  private qualityPosition(b: Uint8Array, n: number, line: Line, ctx: Context): void {
    const remaining = this.seqLen - this.qualLen;
    this.qualTail = n;
    // Every record so far had one sequence line and one quality line: a second quality line would be a first.
    const fourLine = !this.wrappedSeen && this.reads > 0 && this.seqLines === 1;
    if (n > 0 && b[0] === 64 && (n === remaining ? fourLine && this.qualLines > 0 : n > remaining || fourLine || hasWhitespace(b, n))) {
      if (this.suspect.length < n) this.suspect = new Uint8Array(Math.max(n, 256));
      this.suspect.set(b);
      this.suspectLen = n;
      this.suspectLine = line.no;
      this.state = S_TITLE;
      return;
    }
    if (n > remaining) {
      ctx.report(Q.lengthMismatch, remaining, n, this.mismatch(this.qualLen + n), {
        hint: 'bases were removed without removing their qualities, or two records were merged; regenerate the file',
        notes: [`record starts on line ${this.titleLine}`],
      });
      this.qualityLine(b, n, line, ctx);
      this.commit();
      return;
    }
    if (n === 0 && remaining > 0) {
      ctx.report(Q.lengthMismatch, -1, -1, this.qualLen === 0 ? `the quality line of ${this.name()} is empty but its sequence has ${plural(this.seqLen, 'base')}` : this.mismatch(this.qualLen), {
        hint: SHORT_HINT,
        notes: [`record starts on line ${this.titleLine}`],
      });
      this.commit();
      return;
    }
    this.qualLen += n;
    if (++this.qualLines === 2) this.qualWrapLine = line.no;
    this.lastQualLine = line.no;
    this.qualityLine(b, n, line, ctx);
    if (this.qualLen === this.seqLen) this.completeQuality(ctx);
  }

  private completeQuality(ctx: Context): void {
    if (this.qualLines > 1 && this.seqLines === 1) {
      ctx.reportAt(Q.multiLineRecord, this.qualWrapLine, `the quality of ${this.name()} continues on a second line (${plural(this.qualLines, 'line')}, ${plural(this.qualLen, 'character')})`, {
        hint: 'most tools expect four lines per record; unwrap with `seqtk seq -l0 in.fq > out.fq`',
      });
    }
    this.commit();
  }

  private mismatch(qualityLength: number): string {
    return `quality has ${plural(qualityLength, 'character')} but the sequence of ${this.name()} has ${plural(this.seqLen, 'base')}`;
  }

  end(ctx: Context): void {
    if (this.suspectLine > 0) this.resolveSuspect(true, ctx);
    if (this.state !== S_TITLE) {
      const missing = this.state === S_SEQ ? 'the sequence, `+` and quality lines are missing'
        : this.state === S_PLUS ? 'the `+` and quality lines are missing'
        : this.qualLen > 0 ? `the quality stops after ${this.qualLen} of ${plural(this.seqLen, 'character')}`
        : 'the quality line is missing';
      ctx.reportAt(Q.truncatedRecord, this.titleLine, `the file ends inside ${this.name()}: ${missing}`, {
        hint: 'the file is truncated (interrupted transfer, full disk, `head -n` with a count that is not a multiple of 4): fetch or generate it again and compare checksums',
      });
      this.interleaved = 2;
    }
    if (this.blankCount > 0) {
      const k = this.blankCount;
      // The mechanical repair strips every empty line at the end of the file. After a zero-length read that would
      // also remove its (empty) quality line, so the fix is only offered when the last record line has content.
      const safe = this.state === S_TITLE && this.lastQualityEmpty === false;
      ctx.reportAt(T.trailingBlankLines, this.blankLine, `${plural(k, 'blank line')} at the end of the file`, {
        hint: 'delete the empty line' + (k === 1 ? '' : 's') + (safe ? '' : ', but keep the empty quality line of the zero-length read before it'),
        ...(safe ? { fix: { title: 'Remove trailing blank lines', transform: 'trim-trailing-blank-lines' as const } } : {}),
      });
    }
    if (this.interleaved === 1 && this.reads % 2 === 1) {
      ctx.reportAt(Q.pairCountMismatch, this.lastTitleLine, `the reads are interleaved pairs, but the file has ${plural(this.reads, 'read')}: the last read has no mate`, {
        hint: 'the file is truncated or a mate was filtered out; re-pair with `seqkit pair` or BBMap `repair.sh in=reads.fq out=fixed.fq outs=singletons.fq`',
      });
    }

    // Quality encoding, from the range of characters in the whole file (Cock et al., Table 1). Only a file with
    // nothing below `;` (59) can be a +64 variant, and only characters above `J` (74, Q41 in Phred+33) are evidence
    // that it is one; files of a single constant quality character are synthetic and are taken as Phred+33. Characters above
    // `j` (106, Q42 in Phred+64) do not occur in real +64 data but do in long-read Phred+33 data.
    let encoding = 'unknown';
    if (this.qmax >= this.qmin) {
      encoding = 'Phred+33';
      if (this.qmin >= 59 && this.qmin < this.qmax && this.qmax > 74 && this.qmax <= 106) {
        const solexa = this.qmin < 64;
        encoding = solexa ? 'Solexa+64' : 'Phred+64';
        const range = `\`${String.fromCharCode(this.qmin)}\` (${this.qmin}) to \`${String.fromCharCode(this.qmax)}\` (${this.qmax})`;
        ctx.reportAt(Q.legacyQualityEncoding, 0, `quality characters range from ${range}: this looks like ${solexa ? 'Solexa scores with offset 64 (Solexa/early Illumina)' : 'an offset-64 encoding (Illumina 1.3-1.7, or Solexa)'}, not the standard Phred+33`, {
          hint: solexa
            ? 'convert to Sanger encoding with Biopython `SeqIO.convert("in.fq", "fastq-solexa", "out.fq", "fastq-sanger")` or EMBOSS `seqret`'
            : 'if the data are Illumina 1.3-1.7, convert with `seqtk seq -Q64 -V in.fq > out.fq`; for Solexa scores use Biopython `SeqIO.convert("in.fq", "fastq-solexa", "out.fq", "fastq-sanger")`',
          notes: ['no quality character is below `;` (59) and some are above `J` (74), which standard Phred+33 short-read data does not produce'],
        });
      }
    }
    ctx.stat('reads', this.reads);
    ctx.stat('bases', this.bases);
    ctx.stat('encoding', encoding);
    ctx.stat('nameDigest', hex8(this.hi) + hex8(this.lo));
    ctx.stat('nameCheckpoints', this.checkpoints);
  }

  // ------------------------------------------------------------------------------------------ record structure

  private startRecord(b: Uint8Array, n: number, lineNo: number, ctx: Context, onCurrentLine: boolean): void {
    if (this.blankCount > 0) {
      if (!this.skipping) {
        ctx.reportAt(Q.blankLine, this.blankLine, `${plural(this.blankCount, 'blank line')} between records`, {
          hint: 'remove the empty line; four-line parsers stop here',
        });
      }
      this.blankCount = 0;
    }
    this.skipping = false;
    if (this.title.length < n) this.title = new Uint8Array(n * 2);
    this.title.set(b.length === n ? b : b.subarray(0, n));
    this.titleLen = n;
    this.titleLine = lineNo;
    this.seqLen = 0; this.seqLines = 0; this.qualLen = 0; this.qualLines = 0;
    this.state = S_SEQ;

    // Normalised name: up to the first whitespace, without a trailing /1 or /2.
    let e = 1;
    while (e < n && b[e] !== 32 && b[e] !== 9) e++;
    // Which mate the title says this is: `name/1`, `name 1:N:0:...` (Illumina), or `/1` at the very end of the title.
    let mate = 0;
    if (e + 2 < n && b[e + 2] === 58 && (b[e + 1] === 49 || b[e + 1] === 50)) mate = b[e + 1]! - 48;
    else if (n >= 3 && b[n - 2] === 47 && (b[n - 1] === 49 || b[n - 1] === 50)) mate = b[n - 1]! - 48;
    if (e >= 3 && b[e - 2] === 47 && (b[e - 1] === 49 || b[e - 1] === 50)) { mate = b[e - 1]! - 48; e -= 2; }
    let hi = this.hi, lo = this.lo, h32 = 0x811c9dc5;
    for (let i = 1; i <= e; i++) {
      const c = i < e ? b[i]! : 10; // a newline closes each name, so ("ab","c") and ("a","bc") differ
      h32 = Math.imul(h32 ^ c, 16777619);
      // FNV-1a, 64 bit: hash = (hash ^ byte) * 0x100000001b3, with the product formed from exact doubles.
      lo = (lo ^ c) >>> 0;
      const t = lo * 435;
      hi = (hi * 435 + Math.floor(t / 4294967296) + lo * 256) >>> 0;
      lo = t >>> 0;
    }
    this.pendingHi = hi; this.pendingLo = lo;
    this.prevNameHash = this.nameHash; this.prevNameLen = this.nameLen;
    this.nameHash = h32; this.nameLen = e;

    // Interleaved pairs: reads 1 and 2 share a name and are marked as mate 1 and mate 2. (A shared name alone is not
    // enough: some files simply contain every read twice.) From then on every even read must be the mate of the one before.
    if (this.interleaved === 2) return;
    const index = this.reads + 1;
    const same = this.nameHash === this.prevNameHash && this.nameLen === this.prevNameLen;
    if (this.interleaved === 0) {
      if (index === 1) this.firstMate = mate;
      else if (index === 2) this.interleaved = same && this.firstMate === 1 && mate === 2 ? 1 : 2;
    } else if (index % 2 === 0 && !same) {
      this.interleaved = 2;
      const message = `read ${index.toLocaleString('en-US')} is named ${this.name()} but its mate, the read before it, has a different name`;
      const extra = {
        hint: 'the file is interleaved (reads 1 and 2 are the two mates of one fragment), so reads must alternate mate 1, mate 2; a read was lost or the mates were filtered separately. Re-pair with BBMap `repair.sh in=reads.fq out=fixed.fq outs=singletons.fq`',
        notes: [`previous read on line ${this.lastTitleLine}`],
      };
      if (onCurrentLine) ctx.report(Q.pairNameMismatch, 1, Math.max(e, 2), message, extra);
      else ctx.reportAt(Q.pairNameMismatch, lineNo, message, extra);
    }
  }

  private commit(): void {
    this.reads++;
    this.bases += this.seqLen;
    this.hi = this.pendingHi; this.lo = this.pendingLo;
    if (this.reads % NAME_BLOCK === 0) this.checkpoints += hex8(this.hi) + hex8(this.lo);
    if (this.seqLines > 1 || this.qualLines > 1) this.wrappedSeen = true;
    this.lastTitleLine = this.titleLine;
    this.lastQualityEmpty = this.qualTail === 0;
    this.state = S_TITLE;
  }

  /**
   * Settle a line that was set aside in quality position, now that the following line (or the end of the file) is known.
   * `titleFollows` is true when what follows is a title line, a blank line or the end of the file: then the line
   * was quality. Otherwise it was the title of the next record, and the current record's quality is short or absent.
   */
  private resolveSuspect(titleFollows: boolean, ctx: Context): number {
    const lineNo = this.suspectLine;
    const n = this.suspectLen;
    this.suspectLine = 0;
    const remaining = this.seqLen - this.qualLen;
    if (titleFollows) {
      this.qualTail = n;
      const q = this.suspect;
      for (let i = 0; i < n; i++) { const c = q[i]!; if (c >= 33 && c <= 126) { if (c < this.qmin) this.qmin = c; if (c > this.qmax) this.qmax = c; } }
      this.state = S_QUAL;
      if (n < remaining) {
        this.qualLen += n;
        if (++this.qualLines === 2) this.qualWrapLine = lineNo;
        this.lastQualLine = lineNo;
        return SUSPECT_WAS_PARTIAL_QUALITY;
      }
      if (n === remaining) {
        this.qualLen += n;
        if (++this.qualLines === 2) this.qualWrapLine = lineNo;
        this.completeQuality(ctx);
        return SUSPECT_WAS_QUALITY;
      }
      ctx.reportAt(Q.lengthMismatch, lineNo, this.mismatch(this.qualLen + n), {
        hint: 'bases were removed without removing their qualities, or two records were merged; regenerate the file',
        notes: [`record starts on line ${this.titleLine}`],
      });
      this.commit();
      return SUSPECT_WAS_QUALITY;
    }
    if (this.qualLines === 0) {
      this.interleaved = 2;
      ctx.reportAt(Q.truncatedRecord, this.titleLine, `${this.name()} has no quality line: the next record starts on line ${lineNo}, right after the \`+\` line`, {
        hint: 'a line was lost; regenerate the file or remove the incomplete record',
      });
    } else {
      ctx.reportAt(Q.lengthMismatch, this.lastQualLine, this.mismatch(this.qualLen), { hint: SHORT_HINT, notes: [`record starts on line ${this.titleLine}`] });
      this.commit();
    }
    this.startRecord(this.suspect, n, lineNo, ctx, false);
    return SUSPECT_WAS_TITLE;
  }

  private reportNotTitle(b: Uint8Array, n: number, line: Line, ctx: Context): void {
    this.interleaved = 2;
    const c0 = b[0]!;
    let hint = 'a line was lost or added before this point; each record is four lines: `@title`, sequence, `+`, quality';
    if (c0 === 62) hint = 'a line starting with `>` is FASTA: check the file with `--type fasta`';
    else if (this.reads === 0 && c0 !== 43) hint = 'the first line of a FASTQ file starts with `@`; this may be another format, or the first line was cut off';
    else if (c0 === 43) hint = 'a `+` line here means the previous record had an extra line, or its sequence is wrapped while its quality is not';
    else if (isSequenceLike(b, n)) hint = 'this looks like a sequence line whose `@title` line is missing';
    ctx.report(Q.titleMissingAt, 0, 1, `expected a title line starting with \`@\` but found \`${show(line.text, 24)}\``, {
      hint,
      notes: this.reads > 0 ? [`${plural(this.reads, 'record')} before this line were read without structural problems`] : [],
    });
  }

  private name(): string {
    let e = 1;
    const t = this.title;
    while (e < this.titleLen && t[e] !== 32 && t[e] !== 9) e++;
    return e > 1 ? `read \`${show(String.fromCharCode.apply(null, t.subarray(1, Math.min(e, 80)) as unknown as number[]))}\`` : 'the unnamed read';
  }

  private titleText(): string {
    return String.fromCharCode.apply(null, this.title.subarray(1, Math.min(this.titleLen, 200)) as unknown as number[]);
  }

  private plusMatchesTitle(b: Uint8Array, n: number): boolean {
    if (n !== this.titleLen) return false;
    const t = this.title;
    for (let i = 1; i < n; i++) if (b[i] !== t[i]) return false;
    return true;
  }

  // ------------------------------------------------------------------------------------------ content

  private sequenceLine(b: Uint8Array, n: number, line: Line, ctx: Context): void {
    this.seqLen = n;
    this.firstSeqLen = n;
    this.seqLines = 1;
    this.state = S_PLUS;
    if (n === 0) return; // reported as an empty read once the `+` line shows that the record is otherwise intact
    let acc = 0;
    for (let i = 0; i < n; i++) acc |= SEQ[b[i]!]!;
    if (acc === 0) return;
    const text = line.text;
    if (acc & C_SPACE) {
      let s = 0, count = 0;
      for (let i = n - 1; i >= 0; i--) if (SEQ[b[i]!] === C_SPACE) { s = i; count++; }
      let e = s;
      while (e < n && SEQ[b[e]!] === C_SPACE) e++;
      ctx.report(Q.whitespaceInRecord, s, e, `${plural(count, 'whitespace character')} in the sequence of ${this.name()}`, {
        hint: e === n ? 'remove the trailing whitespace' : 'whitespace is not allowed in a sequence; the file may be a table that was converted incompletely',
      });
    }
    if (!(acc & C_OTHER)) return;
    // Colour space (SOLiD): a base followed by digits 0-3 and dots. One diagnostic for the read.
    if (n > 1 && SEQ[b[0]!] === 0 && /^[A-Za-z][0-3.]+$/.test(text)) {
      ctx.report(Q.sequenceInvalidCharacter, 1, n, `the sequence of ${this.name()} is in SOLiD colour space (\`${show(text, 16)}\`)`, {
        hint: 'colour-space FASTQ (csfastq) needs colour-aware tools; it is not base-space FASTQ',
      });
      return;
    }
    let shown = 0;
    for (let i = 0; i < n && shown < PER_LINE; i++) {
      const c = b[i]!;
      if (SEQ[c] !== C_OTHER) continue;
      let len = 1;
      if (c >= 0x80) while (i + len < n && (b[i + len]! & 0xc0) === 0x80) len++;
      const ch = text.slice(i, i + len);
      ctx.report(Q.sequenceInvalidCharacter, i, i + len, `\`${show(ch)}\` in the sequence of ${this.name()} is not a nucleotide code`, {
        hint: ch === '.' ? 'write an uncalled base as `N`; tools differ in what they do with `.`'
          : ch === '*' ? 'remove the `*`; it is not a nucleotide code'
          : 'sequences use A C G T U, N and the IUPAC ambiguity codes; replace an unknown base with `N`',
      });
      shown++; i += len - 1;
    }
  }

  private qualityLine(b: Uint8Array, n: number, line: Line, ctx: Context): void {
    let mn = 255, mx = 0;
    for (let i = 0; i < n; i++) { const c = b[i]!; if (c < mn) mn = c; if (c > mx) mx = c; }
    if (mn < 33 || mx > 126) {
      // Slow path: report, and take the range from the valid characters only.
      mn = 255; mx = 0;
      let spaces = 0, firstSpace = -1, shown = 0;
      const text = line.text;
      for (let i = 0; i < n; i++) {
        const c = b[i]!;
        if (c >= 33 && c <= 126) { if (c < mn) mn = c; if (c > mx) mx = c; continue; }
        if (c === 32 || c === 9) { spaces++; if (firstSpace < 0) firstSpace = i; continue; }
        if (c < 0x80) continue; // other control characters: TXT007
        let len = 1;
        while (i + len < n && (b[i + len]! & 0xc0) === 0x80) len++;
        if (shown++ < PER_LINE) {
          ctx.report(Q.qualityInvalidCharacter, i, i + len, `\`${show(text.slice(i, i + len))}\` in the quality of ${this.name()} is not a quality character`, {
            hint: 'quality characters are the printable ASCII range `!` (33) to `~` (126); the file is damaged or was re-encoded',
          });
        }
        i += len - 1;
      }
      if (spaces > 0) {
        let e = firstSpace;
        while (e < n && (b[e] === 32 || b[e] === 9)) e++;
        ctx.report(Q.whitespaceInRecord, firstSpace, e, `${plural(spaces, 'whitespace character')} in the quality of ${this.name()}`, {
          hint: e === n ? 'remove the trailing whitespace' : 'a space is not a quality character (the range starts at `!`); the line may hold space-separated numbers from a QUAL file',
        });
      }
    }
    if (mn < this.qmin) this.qmin = mn;
    if (mx > this.qmax) this.qmax = mx;
  }
}

function hasWhitespace(b: Uint8Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (b[i] === 32 || b[i] === 9) return true;
  return false;
}

/** Only nucleotide codes: used to tell a wrapped sequence line from a quality line when no `+` has been seen. */
function isSequenceLike(b: Uint8Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (SEQ[b[i]!] !== 0) return false;
  return true;
}

export const fastq: FormatDef = {
  id: 'fastq',
  name: 'FASTQ',
  description: 'FASTQ sequencing reads with qualities',
  extensions: ['.fastq', '.fq'],
  blankLinesAreData: true,
  rules: Object.values(Q),
  sniff(head) {
    let i = 0;
    while (i < head.length && head[i]!.trim() === '') i++;
    const first = head[i];
    if (first === undefined || !first.startsWith('@')) return 0;
    // A SAM header also starts with `@`; only FASTQ has a `+` line two lines further on.
    const plus = head[i + 2];
    if (plus !== undefined && plus.startsWith('+')) return 0.95;
    // A wrapped record: the `+` line comes later, before any other `@` line.
    for (let k = i + 2; k < head.length; k++) {
      if (head[k]!.startsWith('+')) return 0.6;
      if (head[k]!.startsWith('@')) break;
    }
    return 0;
  },
  create() { return new FastqValidator(); },
};
