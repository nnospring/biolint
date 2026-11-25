import type { Context, FormatDef, Line, Validator } from '../../core/types.ts';
import { show } from '../../core/util.ts';
import { R } from './rules.ts';
import { IdTable, Interner, RE_SCORE, coordinateHint, parsePositiveInt, reportColumnCount, scoreHint, sniffGtf, splitTabs, strandHint } from '../gff3/shared.ts';

const COLUMN = ['seqname', 'source', 'feature', 'start', 'end', 'score', 'strand', 'frame', 'attributes'];
/** The nine feature types GTF 2.2 defines. */
const GTF22_TYPES = ['CDS', 'start_codon', 'stop_codon', 'exon', '5UTR', '3UTR', 'inter', 'inter_CNS', 'intron_CNS'];
/** Feature types that are parts of a transcript: the GTF 2.2 ones and those Ensembl and GENCODE add. */
const TRANSCRIPT_LEVEL = new Set(['CDS', 'start_codon', 'stop_codon', 'exon', '5UTR', '3UTR', 'intron_CNS', 'transcript', 'UTR', 'five_prime_utr', 'three_prime_utr', 'Selenocysteine']);
const RE_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

// Columns of the transcript table.
const LINE = 0;        // first line that names the transcript
const META = 1;        // sequence code << 2 | strand (0 unknown, 1 plus, 2 minus)
const CDS_START = 2;   // the most recent CDS line of the transcript
const CDS_END = 3;
const STOP_START = 4;  // the most recent stop_codon line
const STOP_END = 5;

/**
 * Memory: bounded by the longest line, except for one table entry per distinct transcript_id, which is needed to
 * notice a transcript that reappears on another sequence or strand anywhere in the file. An entry is 32 bytes of
 * typed arrays plus 5 to 11 bytes of bucket space (see `IdTable`); the identifier text is not kept. A human GENCODE
 * annotation has about 250,000 transcripts, i.e. roughly 10 MB.
 */
class GtfValidator implements Validator {
  private readonly fields: string[] = [];
  private readonly starts: number[] = [];
  private features = 0;
  private readonly seqnames = new Interner((1 << 28) - 1);
  private readonly transcripts = new IdTable(6);
  private lastTx = '\u0000';
  private lastTxEntry = -1;

  // Results of scanning column 9 of the current line.
  private geneIdx = -1;
  private txIdx = -1;
  private geneKey = -1;
  private txKey = -1;
  private txS = -1;
  private txE = -1;

  private readonly strict: boolean;
  private readonly checkSeparator: boolean;
  private readonly checkStop: boolean;

  constructor(ctx: Context) {
    this.strict = ctx.profile === 'strict';
    this.checkSeparator = ctx.enabled(R.attributeSeparator);
    this.checkStop = ctx.enabled(R.stopCodonInCds);
  }

  line(l: Line, ctx: Context): void {
    const text = l.text;
    if (text.length === 0 || text.charCodeAt(0) === 35 /* # */) return; // blank lines and comment lines
    if (text.trim() === '') return;
    this.feature(text, l.no, ctx);
  }

  end(ctx: Context): void {
    ctx.stat('version', 'GTF');
    ctx.stat('features', this.features);
    ctx.stat('transcripts', this.transcripts.size);
  }

  private feature(text: string, no: number, ctx: Context): void {
    this.features++;
    const f = this.fields;
    const st = this.starts;
    const n = splitTabs(text, f, st);
    let lineEnd = text.length;
    if (n !== 9) {
      // GTF 2.2 allows a comment after the attributes; some files put a tab in front of it.
      if (n === 10 && f[9]!.charCodeAt(0) === 35) {
        lineEnd = st[9]! - 1;
        this.comment(st[9]!, text, ctx);
      } else {
        let extraEmpty = n > 9;
        for (let i = 9; i < n && extraEmpty; i++) if (f[i] !== '') extraEmpty = false;
        if (!extraEmpty) { reportColumnCount(ctx, R.columnCount, text, n, st, 'GTF'); return; }
        lineEnd = st[9]! - 1;
        ctx.report(R.trailingTab, lineEnd, text.length, 'the line ends with a tab after the attributes column', { hint: 'remove the trailing tab' });
      }
    }
    for (let i = 0; i < 3; i++) if (f[i] === '') this.empty(i, ctx);
    const seqname = f[0]!;
    const feature = f[2]!;

    const start = parsePositiveInt(f[3]!);
    const end = parsePositiveInt(f[4]!);
    if (start < 0) ctx.report(R.coordinateInvalid, st[3]!, st[3]! + Math.max(1, f[3]!.length), `start \`${show(f[3]!)}\` is not a positive integer`, { hint: coordinateHint(f[3]!, 'start') });
    if (end < 0) ctx.report(R.coordinateInvalid, st[4]!, st[4]! + Math.max(1, f[4]!.length), `end \`${show(f[4]!)}\` is not a positive integer`, { hint: coordinateHint(f[4]!, 'end') });
    if (start > 0 && end > 0 && start > end) {
      ctx.report(R.startAfterEnd, st[3]!, st[4]! + f[4]!.length, `start ${start} is greater than end ${end}`, {
        hint: f[6] === '-' ? `write the smaller coordinate first (start ${end}, end ${start}): the \`-\` in column 7 already says the feature is on the reverse strand` : 'swap the two coordinates',
      });
    }
    const score = f[5]!;
    if (score !== '.') {
      if (score === '') this.empty(5, ctx);
      else if (!RE_SCORE.test(score)) ctx.report(R.scoreInvalid, st[5]!, st[5]! + score.length, `score \`${show(score)}\` is not a number`, { hint: scoreHint(score) });
    }
    const strand = f[6]!;
    if (strand !== '+' && strand !== '-' && strand !== '.') {
      ctx.report(R.strandInvalid, st[6]!, st[6]! + Math.max(1, strand.length), strand === '' ? 'the strand column is empty' : `strand \`${show(strand)}\` is not one of \`+\`, \`-\`, \`.\``, {
        hint: strand === '?' ? '`?` is a GFF3 value; in GTF write `.` when the strand is unknown' : strandHint(strand, '`+`, `-`, or `.` for a feature without a strand'),
      });
    }
    const frame = f[7]!;
    if (frame === '.') {
      if (feature === 'CDS' || (this.strict && (feature === 'start_codon' || feature === 'stop_codon'))) {
        ctx.report(R.frameMissing, st[7]!, st[7]! + 1, `${feature} feature has no frame`, {
          hint: feature === 'CDS'
            ? 'write 0, 1 or 2: the number of bases before the first complete codon of this segment, counted from its 5\' end (0 for the segment that begins with the start codon)'
            : 'write 0 for a codon in one piece; for a codon split by an intron, the number of its bases that precede this piece',
        });
      }
    } else if (frame !== '0' && frame !== '1' && frame !== '2') {
      let hint = 'the frame is 0, 1 or 2 for CDS, start_codon and stop_codon lines, and `.` for other features';
      if (frame === '') hint = 'write `.` for a feature that is not coding';
      else if (frame === '3' || /^[-+][123]$/.test(frame)) hint = 'this looks like a reading frame from another convention; the GTF frame is the number of bases (0, 1 or 2) before the first complete codon';
      else if (frame === '+' || frame === '-') hint = 'this looks like a strand: a column may be missing before it';
      ctx.report(R.frameInvalid, st[7]!, st[7]! + Math.max(1, frame.length), frame === '' ? 'the frame column is empty' : `frame \`${show(frame)}\` is not 0, 1, 2 or \`.\``, { hint });
    }
    // Feature type
    let transcriptLevel = TRANSCRIPT_LEVEL.has(feature);
    if (feature !== '' && !GTF22_TYPES.includes(feature)) {
      const lower = feature.toLowerCase();
      const canonical = GTF22_TYPES.find((t) => t.toLowerCase() === lower);
      if (canonical) {
        transcriptLevel = TRANSCRIPT_LEVEL.has(canonical);
        ctx.report(R.featureCase, st[2]!, st[2]! + feature.length, `feature type \`${show(feature)}\` must be written \`${canonical}\``, { hint: 'feature types are case-sensitive; tools that select `' + canonical + '` lines skip this one' });
      } else if (this.strict) {
        ctx.report(R.featureNonstandard, st[2]!, st[2]! + feature.length, `feature type \`${show(feature)}\` is not one of the nine GTF 2.2 types`, {
          hint: feature === 'gene' || feature === 'transcript' ? 'Ensembl and GENCODE files contain these lines and current tools accept them; a parser that follows GTF 2.2 ignores the line' : 'a parser that follows GTF 2.2 ignores this line',
        });
      }
    }

    // Attributes
    const a0 = st[8]!;
    if (lineEnd === a0) { this.empty(8, ctx); return; }
    this.geneIdx = -1; this.txIdx = -1; this.txS = -1;
    if (!this.attributes(text, a0, lineEnd, ctx)) return;
    if (this.geneIdx < 0) {
      ctx.report(R.geneIdMissing, a0, lineEnd, 'the line has no `gene_id` attribute', {
        hint: text.slice(a0, lineEnd).trim() === '.' ? 'column 9 must hold at least `gene_id "..."; transcript_id "...";`' : 'add `gene_id "...";` as the first attribute; tools that count reads per gene need it on every line',
      });
    }
    if (this.txIdx < 0) {
      if (transcriptLevel) {
        ctx.report(R.transcriptIdMissing, a0, lineEnd, `the ${show(feature)} line has no \`transcript_id\` attribute`, {
          hint: 'add `transcript_id "...";` after `gene_id`; if the annotation has one transcript per gene, the gene identifier can be reused',
        });
      } else if (this.strict) {
        ctx.report(R.geneLineWithoutTranscriptId, a0, lineEnd, `the ${show(feature)} line has no \`transcript_id\` attribute`, {
          hint: 'GTF 2.2 requires it on every line: write `transcript_id "";` when the feature belongs to no transcript',
        });
      }
    } else if (this.strict && this.geneIdx >= 0 && (this.geneIdx !== 0 || this.txIdx !== 1)) {
      const at = this.geneIdx !== 0 ? this.geneKey : this.txKey;
      ctx.report(R.mandatoryAttributesNotFirst, at, at + (this.geneIdx !== 0 ? 7 : 13),
        this.geneIdx !== 0 ? `\`gene_id\` is attribute ${this.geneIdx + 1}, not the first` : `\`transcript_id\` is attribute ${this.txIdx + 1}, not the second`, {
          hint: 'put `gene_id` first and `transcript_id` second, before all other attributes',
        });
    }
    if (this.txS >= 0 && this.txE > this.txS) this.transcript(text, no, feature, seqname, strand, start, end, ctx);
  }

  private empty(col: number, ctx: Context): void {
    const at = this.starts[col]!;
    ctx.report(R.emptyField, at, at + 1, `the ${COLUMN[col]} column is empty`, {
      hint: col === 8 ? 'column 9 must hold at least `gene_id "..."; transcript_id "...";`' : 'write `.` for a value that is unknown or does not apply',
    });
  }

  private comment(at: number, text: string, ctx: Context): void {
    ctx.report(R.inlineComment, at, text.length, 'comment at the end of a feature line', {
      hint: 'move the comment to a line of its own: most parsers do not strip it and read it as part of the attributes',
    });
  }

  // ------------------------------------------------------------------ column 9

  /**
   * Scan `key value;` attributes in `text[s, e)`, honouring double quotes. Reports at most one grammar problem per
   * line. Returns false when the column could not be read well enough to say which attributes are present.
   */
  private attributes(text: string, s: number, e: number, ctx: Context): boolean {
    let i = s;
    let index = 0;
    let broken = false;
    if (e - s === 1 && text.charCodeAt(s) === 46) return true; // `.`: no attributes at all
    let sepReported = !this.checkSeparator;
    while (i < e) {
      const gap = i;
      let c = text.charCodeAt(i);
      while (c === 32 || c === 9) { i++; if (i >= e) break; c = text.charCodeAt(i); }
      if (i >= e) break;
      if (c === 35 /* # */) { this.comment(i, text, ctx); break; }
      if (!sepReported && index > 0 && (i - gap !== 1 || text.charCodeAt(gap) !== 32)) {
        sepReported = true;
        ctx.report(R.attributeSeparator, i === gap ? gap - 1 : gap, i === gap ? gap : i, i === gap ? 'no space between the semicolon and the next attribute' : 'more than one space between two attributes', {
          hint: 'separate attributes with a semicolon followed by exactly one space',
        });
      }
      if (c === 59 /* ; */) {
        if (!sepReported) { sepReported = true; ctx.report(R.attributeSeparator, i, i + 1, 'empty attribute: a semicolon with nothing before it', { hint: 'remove the extra semicolon' }); }
        i++;
        continue;
      }
      // key
      const k = i;
      while (i < e) { c = text.charCodeAt(i); if (c === 32 || c === 34 || c === 59 || c === 61 || c === 9) break; i++; }
      if (i < e && c === 61 /* = */ && i > k) {
        if (!broken) {
          let stop = text.indexOf(';', i); if (stop < 0 || stop > e) stop = e;
          const key = text.slice(k, i), value = text.slice(i + 1, stop);
          ctx.report(R.gff3StyleAttributes, k, stop, `attribute \`${show(key)}=${show(value, 24)}\` is written in the GFF3 style, not as \`key "value";\``, {
            hint: this.features <= 1
              ? 'the file is GFF3, not GTF: check it with `--type gff3`, or convert it with `gffread in.gff3 -T -o out.gtf`'
              : `in GTF this is \`${show(key)} "${show(value, 24)}";\`; a GFF3 file is converted with \`gffread in.gff3 -T -o out.gtf\``,
          });
        }
        return false;
      }
      if (i === k) {
        // A value with no key: the column starts with a quote.
        if (!broken) ctx.report(R.attributeMalformed, k, Math.min(e, k + 1), 'a quoted value with no key in front of it', { hint: 'each attribute is a key, a space and a value: `gene_id "g1";`' });
        return false;
      }
      const keyEnd = i;
      while (i < e && text.charCodeAt(i) === 32) i++;
      if (i >= e || text.charCodeAt(i) === 59) {
        if (!broken) {
          broken = true;
          const key = text.slice(k, keyEnd);
          ctx.report(R.attributeMalformed, k, keyEnd, `attribute \`${show(key)}\` has no value`, {
            hint: key === '.' ? 'column 9 must hold at least `gene_id "..."; transcript_id "...";`' : `write \`${show(key)} "...";\`, or \`${show(key)} "";\` if it is deliberately empty`,
          });
        }
        // The key is there, even though its value is not: do not also report it as missing.
        if (keyEnd - k === 7 && text.startsWith('gene_id', k)) { if (this.geneIdx < 0) { this.geneIdx = index; this.geneKey = k; } }
        else if (keyEnd - k === 13 && text.startsWith('transcript_id', k)) { if (this.txIdx < 0) { this.txIdx = index; this.txKey = k; } }
        if (i < e) i++;
        index++;
        continue;
      }
      // value
      let vS: number, vE: number;
      if (text.charCodeAt(i) === 34 /* " */) {
        const close = text.indexOf('"', i + 1);
        if (close < 0 || close >= e) {
          if (!broken) {
            ctx.report(R.unclosedQuote, i, i + 1, `the quoted value of \`${show(text.slice(k, keyEnd))}\` is never closed`, {
              hint: 'add the closing `"` before the semicolon',
            });
          }
          return false;
        }
        vS = i + 1; vE = close; i = close + 1;
      } else {
        vS = i;
        while (i < e) { c = text.charCodeAt(i); if (c === 59 || c === 32) break; i++; }
        vE = i;
        if (!broken && !RE_NUMBER.test(text.slice(vS, vE))) {
          const key = text.slice(k, keyEnd), value = text.slice(vS, vE);
          const half = value.endsWith('"');
          ctx.report(R.unquotedValue, vS, vE, half ? `the value of \`${show(key)}\` has a closing quote but no opening one` : `the value \`${show(value)}\` of \`${show(key)}\` is not in double quotes`, {
            hint: `write \`${show(key)} "${show(half ? value.slice(0, -1) : value)}";\``,
          });
        }
      }
      if (keyEnd - k === 7 && text.startsWith('gene_id', k)) { if (this.geneIdx < 0) { this.geneIdx = index; this.geneKey = k; } }
      else if (keyEnd - k === 13 && text.startsWith('transcript_id', k)) { if (this.txIdx < 0) { this.txIdx = index; this.txKey = k; this.txS = vS; this.txE = vE; } }
      index++;
      // after the value: a semicolon
      let j = i;
      while (j < e && text.charCodeAt(j) === 32) j++;
      if (j >= e || text.charCodeAt(j) === 35) {
        if (!broken) {
          ctx.report(R.finalSemicolonMissing, i - 1, i, `the last attribute, \`${show(text.slice(k, keyEnd))}\`, does not end with a semicolon`, { hint: 'add `;` at the end of the line' });
        }
        i = j;
        continue;
      }
      if (text.charCodeAt(j) === 59) { i = j + 1; continue; }
      if (!broken) {
        broken = true;
        const key = text.slice(k, keyEnd);
        const glued = j === i; // text directly after the closing quote
        ctx.report(R.semicolonMissing, i - 1, j + 1, `no semicolon after the value of \`${show(key)}\``, {
          hint: glued
            ? 'the value seems to contain a double quote, which ends it early: remove the inner quote, then end the attribute with `;`'
            : 'end every attribute with a semicolon: `gene_id "g1"; transcript_id "t1";`. If the value contains spaces, put it in double quotes',
        });
      }
      i = j;
    }
    return true;
  }

  // ------------------------------------------------------------------ transcripts

  private transcript(text: string, no: number, feature: string, seqname: string, strand: string, start: number, end: number, ctx: Context): void {
    const t = this.transcripts;
    let entry: number;
    if (this.txE - this.txS === this.lastTx.length && text.startsWith(this.lastTx, this.txS)) entry = this.lastTxEntry;
    else {
      entry = t.intern(text, this.txS, this.txE);
      this.lastTx = text.slice(this.txS, this.txE);
      this.lastTxEntry = entry;
    }
    const seq = this.seqnames.code(seqname);
    const sc = strand === '+' ? 1 : strand === '-' ? 2 : 0;
    const first = t.get(LINE, entry);
    if (first === 0) {
      t.set(LINE, entry, no);
      t.set(META, entry, ((seq << 2) | sc) >>> 0);
    } else {
      const meta = t.get(META, entry);
      let seq0 = meta >>> 2, sc0 = meta & 3;
      if (seq0 !== seq && seq0 !== 0 && seq !== 0) {
        ctx.report(R.transcriptMultipleSeqids, this.starts[0]!, this.starts[0]! + seqname.length, `transcript \`${show(this.lastTx)}\` is on \`${show(seqname)}\` here, but its earlier features are on \`${show(this.seqnames.names[seq0]!)}\``, {
          hint: 'two transcripts share this transcript_id: make the identifiers unique (for example with a suffix on the second locus), or remove the duplicate locus',
          notes: [`the transcript first appears on line ${first}`],
        });
        // Follow the new locus so that each change is reported once, not every line.
        seq0 = seq; sc0 = sc;
        t.set(CDS_START, entry, 0); t.set(STOP_START, entry, 0);
      } else if (sc0 !== sc && sc0 !== 0 && sc !== 0) {
        ctx.report(R.transcriptBothStrands, this.starts[6]!, this.starts[6]! + 1, `transcript \`${show(this.lastTx)}\` is on the \`${strand}\` strand here, but its earlier features are on \`${sc0 === 1 ? '+' : '-'}\``, {
          hint: 'all features of a transcript share one strand: correct the strand column, or give the second transcript its own transcript_id (a genuinely trans-spliced transcript has to be removed or split for tools such as RSEM)',
          notes: [`the transcript first appears on line ${first}`],
        });
        sc0 = sc;
        t.set(CDS_START, entry, 0); t.set(STOP_START, entry, 0);
      } else if (sc0 === 0) sc0 = sc;
      if ((((seq0 << 2) | sc0) >>> 0) !== meta) t.set(META, entry, ((seq0 << 2) | sc0) >>> 0);
    }
    if (!this.checkStop || start < 0 || end < 0) return;
    // GTF keeps the stop codon outside the CDS. Compare each stop_codon line with the latest CDS line of its
    // transcript and the other way round, which covers the usual orders in which the two are written. Only a stop
    // codon that forms the 3' end of the CDS segment counts: overlapping genes that (wrongly) share a
    // transcript_id would otherwise be reported.
    if (feature === 'CDS') {
      const s0 = t.get(STOP_START, entry);
      if (s0 !== 0 && this.terminal(s0, t.get(STOP_END, entry), start, end, sc)) this.stopInCds(s0, t.get(STOP_END, entry), start, end, ctx);
      t.set(CDS_START, entry, start); t.set(CDS_END, entry, end);
    } else if (feature === 'stop_codon') {
      const s0 = t.get(CDS_START, entry);
      if (s0 !== 0 && this.terminal(start, end, s0, t.get(CDS_END, entry), sc)) this.stopInCds(start, end, s0, t.get(CDS_END, entry), ctx);
      t.set(STOP_START, entry, start); t.set(STOP_END, entry, end);
    }
  }

  /** True when the stop codon (or the piece of a split one) lies inside the CDS segment, at its 3' end. */
  private terminal(stopStart: number, stopEnd: number, cdsStart: number, cdsEnd: number, strand: number): boolean {
    if (stopStart < cdsStart || stopEnd > cdsEnd) return false;
    return strand === 2 ? stopStart === cdsStart : strand === 1 ? stopEnd === cdsEnd : stopStart === cdsStart || stopEnd === cdsEnd;
  }

  private stopInCds(stopStart: number, stopEnd: number, cdsStart: number, cdsEnd: number, ctx: Context): void {
    const st = this.starts, f = this.fields;
    ctx.report(R.stopCodonInCds, st[3]!, st[4]! + f[4]!.length, `stop codon ${stopStart}-${stopEnd} of transcript \`${show(this.lastTx)}\` is the end of its CDS segment ${cdsStart}-${cdsEnd}`, {
      hint: 'in GTF the CDS ends before the stop codon: shorten the last CDS segment by the stop codon (the file was probably converted from GFF3, where the CDS includes it)',
    });
  }
}

export const gtf: FormatDef = {
  id: 'gtf',
  name: 'GTF',
  description: 'Gene Transfer Format (GTF 2.2, with Ensembl/GENCODE conventions)',
  extensions: ['.gtf'],
  rules: Object.values(R),
  sniff: sniffGtf,
  create(ctx) { return new GtfValidator(ctx); },
};
