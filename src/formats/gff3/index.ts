import type { Context, FormatDef, Line, Validator } from '../../core/types.ts';
import { plural, show } from '../../core/util.ts';
import { G } from './rules.ts';
import {
  IdTable, Interner, RE_SCORE, coordinateHint, looksLikeGtfAttributes, parsePositiveInt, reportColumnCount, scoreHint, sniffGff3, splitTabs, strandHint,
} from './shared.ts';

const COLUMN = ['seqid', 'source', 'type', 'start', 'end', 'score', 'strand', 'phase', 'attributes'];
/** Tags the specification defines; every other tag starting with an upper-case letter is reserved. */
const RESERVED = ['ID', 'Name', 'Alias', 'Parent', 'Target', 'Gap', 'Derives_from', 'Note', 'Dbxref', 'Ontology_term', 'Is_circular'];
/** Characters a seqid may contain unescaped, plus percent escapes. */
const RE_SEQID = /^(?:[A-Za-z0-9.:^*$@!+_?|-]|%[0-9A-Fa-f]{2})+$/;
const RE_SEQID_BAD = /[^A-Za-z0-9.:^*$@!+_?|%-]|%(?![0-9A-Fa-f]{2})/;
const RE_VERSION = /^3(?:\.\d+){0,2}$/;
const RE_GAP = /^[MIDFR]\d+(?: [MIDFR]\d+)*$/;

// Columns of the ID table.
const LINE = 0;     // line of the first feature line with this ID; 0 = only referred to so far
const META = 1;     // feature type code (12 bits) | sequence code << 12
const START = 2;    // start and end of that first line
const END = 3;
const LINK = 4;     // (entry number of the first Parent + 1) | visit state << 30, for the current block only
const LINK_MASK = 0x3fffffff;

interface Pending { name: string; line: number; seq: number; count: number }

/**
 * Memory: everything here is bounded by the longest line, except the ID table. IDs must be unique in the whole
 * file and a Parent may refer to any of them, so one entry per distinct ID is unavoidable. An entry is 28 bytes of
 * typed arrays plus 5 to 11 bytes of bucket space (see `IdTable`), about 40 MB per million IDs; the ID text itself
 * is not kept. What a `###` line allows to be released is released there: the Parent links used for cycle
 * detection (second and further parents, and the link column is zeroed) and the names of parents not yet seen.
 * Sequence names and feature types are kept as small integers (one string per distinct name).
 */
class Gff3Validator implements Validator {
  private readonly fields: string[] = [];
  private readonly starts: number[] = [];
  private features = 0;
  private versionSeen = false;
  private versionLine = 0;
  private versionText = '';
  private versionMissingReported = false;
  private inFasta = false;
  private fastaLine = 0;
  private fastaHeaderSeen = false;
  private fastaOrphanReported = false;

  private lastSeqid = '\u0000';
  private seqCode = 0;
  private region: { start: number; end: number; line: number } | undefined;
  private circular = false;
  private readonly regions = new Map<string, { start: number; end: number; line: number }>();
  private readonly circularSeqids = new Set<string>();
  private readonly seqids = new Interner((1 << 20) - 1);
  private readonly types = new Interner(4095);

  private readonly ids = new IdTable(5);
  /** Entries from here on were created since the last flush; older ones that gained a link are in `blockOld`. */
  private blockStart = 0;
  private readonly blockOld: number[] = [];
  private readonly extraParents = new Map<number, number[]>();
  private readonly pending = new Map<number, Pending>();
  private terminatorLine = 0;

  // Results of parsing column 9 of the current line (offsets into the line; -1 = absent).
  private idS = -1;
  private idE = -1;
  private parS = -1;
  private parE = -1;
  private readonly seenTags: string[] = [];
  private readonly strictEscapes: boolean;

  constructor(ctx: Context) {
    this.strictEscapes = ctx.enabled(G.unescapedCharacter);
  }

  // ------------------------------------------------------------------ dispatch

  line(l: Line, ctx: Context): void {
    const text = l.text;
    if (text.length === 0) return; // blank lines are ignored by parsers
    const c0 = text.charCodeAt(0);
    if (this.inFasta) { this.fasta(text, c0, ctx); return; }
    if (c0 === 35 /* # */) {
      if (text.charCodeAt(1) === 35) this.directive(text, l.no, ctx);
      return;
    }
    if (c0 === 62 /* > */) {
      // A line starting with `>` begins the FASTA section even without `##FASTA` (kept for Artemis output).
      this.startFasta(l.no, ctx);
      this.fastaHeaderSeen = true;
      return;
    }
    if (text.trim() === '') return;
    this.feature(text, l.no, ctx);
  }

  end(ctx: Context): void {
    this.requireVersion(ctx);
    this.flush(ctx);
    ctx.stat('version', this.versionText ? `GFF ${this.versionText}` : 'GFF3');
    ctx.stat('features', this.features);
  }

  private requireVersion(ctx: Context): void {
    if (this.versionSeen || this.versionMissingReported) return;
    this.versionMissingReported = true;
    ctx.reportAt(G.versionMissing, 1, 'the file does not start with `##gff-version 3`', {
      hint: 'insert `##gff-version 3` as the first line',
      notes: ['checking the file as GFF3'],
    });
  }

  // ------------------------------------------------------------------ directives

  private directive(text: string, no: number, ctx: Context): void {
    if (text.charCodeAt(2) === 35) {
      // `###` alone closes all features above it; a longer run of # is a comment.
      if (text.length === 3 || text.slice(3).trim() === '') { this.flush(ctx, true); this.terminatorLine = no; }
      return;
    }
    let sp = 2;
    while (sp < text.length && text.charCodeAt(sp) !== 32 && text.charCodeAt(sp) !== 9) sp++;
    const name = text.slice(0, sp);
    if (name === '##gff-version') {
      if (this.versionSeen) {
        ctx.report(G.versionRepeated, 0, text.length, '`##gff-version` appears again', {
          hint: 'if two GFF3 files were joined with `cat`, merge them with `gt gff3 -sort a.gff3 b.gff3` or AGAT instead, and keep one header',
          notes: [`first seen on line ${this.versionLine}`],
        });
        return;
      }
      this.versionSeen = true;
      this.versionLine = no;
      const value = text.slice(sp).trim();
      if (!RE_VERSION.test(value)) {
        const v0 = text.length - text.slice(sp).trimStart().length;
        const old = /^[12](\.\d+)*$/.test(value);
        ctx.report(G.versionInvalid, value ? v0 : 0, value ? v0 + value.length : text.length,
          value === '' ? '`##gff-version` has no version number' : old ? `the file declares GFF version ${show(value)}, not GFF3` : `\`${show(value)}\` is not a GFF3 version`, {
            hint: old ? 'GFF2 and GTF write column 9 as `key "value";` pairs: check the file with `--type gtf`, or convert it to GFF3 with `gffread` or AGAT' : 'write `##gff-version 3` (a revision such as `3.1.26` is also allowed)',
            notes: ['checking the file as GFF3'],
          });
      } else this.versionText = value;
      if (no !== 1 || this.features > 0) {
        ctx.report(G.versionNotFirst, 0, sp, this.features > 0 ? '`##gff-version` comes after feature lines' : `\`##gff-version\` is on line ${no}, not on the first line`, {
          hint: 'move it to the very top of the file',
        });
      }
      return;
    }
    if (name.startsWith('##gff-version')) {
      if (!this.versionSeen) { this.versionSeen = true; this.versionLine = no; }
      ctx.report(G.versionInvalid, 0, text.length, `\`${show(text)}\` is not a version directive: a space must separate \`##gff-version\` from the number`, {
        hint: 'write `##gff-version 3`',
      });
      return;
    }
    if (name === '##sequence-region') { this.sequenceRegion(text, no, ctx); return; }
    if (name === '##FASTA' || (name.length === 7 && name.toUpperCase() === '##FASTA')) { this.startFasta(no, ctx); return; }
    // Any other directive is application-specific and allowed.
  }

  private sequenceRegion(text: string, no: number, ctx: Context): void {
    const parts = text.trim().split(/\s+/);
    const bad = (message: string, hint: string, from = 0, to = text.length) => ctx.report(G.sequenceRegionInvalid, from, to, message, { hint });
    if (parts.length !== 4) {
      bad(`\`##sequence-region\` has ${plural(parts.length - 1, 'value')}, expected a sequence name, a start and an end`,
        parts.length === 3 ? 'give both ends of the sequence, e.g. `##sequence-region chr1 1 248956422`' : 'the form is `##sequence-region seqid start end`; a sequence name cannot contain spaces');
      return;
    }
    const seqid = parts[1]!;
    const start = parsePositiveInt(parts[2]!);
    const end = parsePositiveInt(parts[3]!);
    if (start < 0 || end < 0) {
      const which = start < 0 ? 2 : 3;
      const at = text.lastIndexOf(parts[which]!, which === 3 ? text.length : text.length - parts[3]!.length - 1);
      bad(`\`##sequence-region\` ${which === 2 ? 'start' : 'end'} \`${show(parts[which]!)}\` is not a positive integer`, coordinateHint(parts[which]!, which === 2 ? 'start' : 'end'), at, at + parts[which]!.length);
      return;
    }
    if (start > end) {
      bad(`\`##sequence-region\` start ${start} is greater than end ${end}`, `write the smaller number first: \`##sequence-region ${seqid} ${end} ${start}\``);
      return;
    }
    const prev = this.regions.get(seqid);
    if (prev) {
      ctx.report(G.sequenceRegionDuplicate, 0, text.length, `a second \`##sequence-region\` for \`${show(seqid)}\``, {
        hint: 'keep one directive per sequence',
        notes: [`first given on line ${prev.line} as ${prev.start}-${prev.end}`],
      });
      return;
    }
    this.regions.set(seqid, { start, end, line: no });
    if (seqid === this.lastSeqid) this.region = this.regions.get(seqid);
  }

  // ------------------------------------------------------------------ FASTA section

  private startFasta(no: number, ctx: Context): void {
    this.requireVersion(ctx);
    this.flush(ctx);
    this.inFasta = true;
    this.fastaLine = no;
  }

  private fasta(text: string, c0: number, ctx: Context): void {
    if (c0 === 62) { this.fastaHeaderSeen = true; return; }
    const note = [`the FASTA section starts on line ${this.fastaLine}`];
    if (c0 === 35 && text.charCodeAt(1) === 35) {
      const again = /^##FASTA\s*$/i.test(text);
      ctx.report(G.fastaSectionContent, 0, text.length, again ? 'a second `##FASTA` directive' : 'a directive inside the FASTA section', {
        hint: again ? 'the file looks like several GFF3 files joined with `cat`: put all features first, then one `##FASTA` and all sequences' : 'move directives above the features; after `##FASTA` only sequences are allowed',
        notes: note,
      });
      return;
    }
    if (c0 === 35 || c0 === 59) return; // comment lines are tolerated by FASTA readers
    const n = splitTabs(text, this.fields, this.starts);
    if (n >= 8 && parsePositiveInt(this.fields[3]!) > 0 && parsePositiveInt(this.fields[4]!) > 0) {
      ctx.report(G.fastaSectionContent, 0, text.length, 'a feature line after `##FASTA`', {
        hint: 'parsers stop reading features at `##FASTA`, so this line is ignored: move all features above it (several files were probably joined with `cat`)',
        notes: note,
      });
      return;
    }
    if (!this.fastaHeaderSeen && !this.fastaOrphanReported && text.trim() !== '') {
      this.fastaOrphanReported = true;
      ctx.report(G.fastaSectionContent, 0, text.length, 'the FASTA section does not begin with a `>` header line', {
        hint: 'each sequence starts with `>` and its name, which must equal the seqid in column 1',
        notes: note,
      });
    }
  }

  // ------------------------------------------------------------------ feature lines

  private feature(text: string, no: number, ctx: Context): void {
    this.requireVersion(ctx);
    this.features++;
    const f = this.fields;
    const st = this.starts;
    const n = splitTabs(text, f, st);
    let lineEnd = text.length;
    if (n !== 9) {
      let extraEmpty = n > 9;
      for (let i = 9; i < n && extraEmpty; i++) if (f[i] !== '') extraEmpty = false;
      if (!extraEmpty) { reportColumnCount(ctx, G.columnCount, text, n, st, 'GFF3'); return; }
      lineEnd = st[9]! - 1;
      ctx.report(G.trailingTab, lineEnd, text.length, n === 10 ? 'the line ends with a tab after the attributes column' : `the line ends with ${n - 9} tabs after the attributes column`, { hint: 'remove the trailing tab' + (n === 10 ? '' : 's') });
    }
    if (text.indexOf('%') >= 0) this.percentEscapes(text, lineEnd, ctx);

    // seqid: checked when it changes, since consecutive lines usually share it.
    const seqid = f[0]!;
    if (seqid !== this.lastSeqid) {
      this.lastSeqid = seqid;
      this.seqCode = this.seqids.code(seqid);
      this.region = this.regions.size ? this.regions.get(seqid) : undefined;
      this.circular = this.circularSeqids.size > 0 && this.circularSeqids.has(seqid);
      if (seqid === '') this.empty(0, ctx);
      else if (!RE_SEQID.test(seqid)) {
        const ws = seqid.search(/\s/);
        if (ws >= 0) {
          ctx.report(G.seqidInvalid, ws, ws + 1, `seqid \`${show(seqid)}\` contains a space`, {
            hint: `use the sequence name up to the first space (\`${show(seqid.slice(0, ws) || seqid.trim())}\`), as FASTA readers do, or write the space as \`%20\``,
          });
        } else {
          const at = seqid.search(RE_SEQID_BAD);
          const ch = seqid[at]!;
          if (ch !== '%') { // a stray % is reported as an invalid escape
            ctx.report(G.seqidCharacters, at, at + 1, `seqid \`${show(seqid)}\` contains \`${show(ch)}\`, which must be percent-encoded`, {
              hint: `write it as \`%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}\`, or rename the sequence here and in the FASTA file; unescaped, a seqid may hold letters, digits and \`.:^*$@!+_?-|\``,
            });
          }
        }
      }
    }
    if (f[1] === '') this.empty(1, ctx);
    const type = f[2]!;
    if (type === '') this.empty(2, ctx);

    // start, end
    const start = parsePositiveInt(f[3]!);
    const end = parsePositiveInt(f[4]!);
    if (start < 0) ctx.report(G.coordinateInvalid, st[3]!, st[3]! + Math.max(1, f[3]!.length), `start \`${show(f[3]!)}\` is not a positive integer`, { hint: coordinateHint(f[3]!, 'start') });
    if (end < 0) ctx.report(G.coordinateInvalid, st[4]!, st[4]! + Math.max(1, f[4]!.length), `end \`${show(f[4]!)}\` is not a positive integer`, { hint: coordinateHint(f[4]!, 'end') });
    if (start > 0 && end > 0) {
      if (start > end) {
        ctx.report(G.startAfterEnd, st[3]!, st[4]! + f[4]!.length, `start ${start} is greater than end ${end}`, {
          hint: f[6] === '-'
            ? `write the smaller coordinate first (start ${end}, end ${start}): the \`-\` in column 7 already says the feature is on the reverse strand`
            : 'swap the two coordinates; for a feature that crosses the origin of a circular sequence, add the sequence length to the end instead',
        });
      } else if (this.region !== undefined) {
        const r = this.region;
        if (start < r.start || end > r.end) {
          // A feature may run past the end of a circular sequence by up to one sequence length.
          const wraps = this.circular && start >= r.start && start <= r.end && end <= r.end + (r.end - r.start + 1);
          if (!wraps) {
            const beyond = end > r.end;
            ctx.report(G.featureOutsideRegion, st[beyond ? 4 : 3]!, st[beyond ? 4 : 3]! + f[beyond ? 4 : 3]!.length,
              `feature ${start}-${end} lies outside \`##sequence-region ${show(seqid)} ${r.start} ${r.end}\``, {
                hint: 'the directive and the features probably come from different assemblies or a subset of the file; correct the directive or remove it',
                notes: [`the region is declared on line ${r.line}`],
              });
          }
        }
      }
    }

    // score
    const score = f[5]!;
    if (score !== '.') {
      if (score === '') this.empty(5, ctx);
      else if (!RE_SCORE.test(score)) ctx.report(G.scoreInvalid, st[5]!, st[5]! + score.length, `score \`${show(score)}\` is not a number`, { hint: scoreHint(score) });
    }
    // strand
    const strand = f[6]!;
    if (strand !== '+' && strand !== '-' && strand !== '.' && strand !== '?') {
      ctx.report(G.strandInvalid, st[6]!, st[6]! + Math.max(1, strand.length), strand === '' ? 'the strand column is empty' : `strand \`${show(strand)}\` is not one of \`+\`, \`-\`, \`.\`, \`?\``, {
        hint: strandHint(strand, '`+`, `-`, `.` (no strand) or `?` (unknown)'),
      });
    }
    // phase
    const phase = f[7]!;
    if (phase === '.') {
      if (type === 'CDS' || type === 'SO:0000316') {
        ctx.report(G.cdsPhaseMissing, st[7]!, st[7]! + 1, 'CDS feature has no phase', {
          hint: 'write 0, 1 or 2: the number of bases to skip at the 5\' end of this segment to reach a complete codon (0 for a segment that begins with the start codon)',
        });
      }
    } else if (phase !== '0' && phase !== '1' && phase !== '2') {
      let hint = 'the phase is 0, 1 or 2 for a CDS, and `.` for every other feature';
      if (phase === '') hint = 'write `.` for a feature that is not a CDS';
      else if (phase === '3' || /^[-+][123]$/.test(phase)) hint = 'this looks like a reading frame; the phase is the number of bases (0, 1 or 2) before the first complete codon of the segment';
      else if (phase === '+' || phase === '-') hint = 'this looks like a strand: a column may be missing before it';
      ctx.report(G.phaseInvalid, st[7]!, st[7]! + Math.max(1, phase.length), phase === '' ? 'the phase column is empty' : `phase \`${show(phase)}\` is not 0, 1, 2 or \`.\``, { hint });
    }

    // attributes, then the relationships they declare
    this.idS = -1;
    this.parS = -1;
    const a0 = st[8]!;
    if (lineEnd === a0) { this.empty(8, ctx); return; }
    if (lineEnd - a0 === 1 && text.charCodeAt(a0) === 46) return;
    if (!this.attributes(text, a0, lineEnd, seqid, ctx)) return;
    if (this.idS >= 0 || this.parS >= 0) this.relationships(text, no, type, seqid, start, end, ctx);
  }

  private empty(col: number, ctx: Context): void {
    const at = this.starts[col]!;
    ctx.report(G.emptyField, at, at + 1, `the ${COLUMN[col]} column is empty`, { hint: 'write `.` for a value that is unknown or does not apply' });
  }

  private percentEscapes(text: string, lineEnd: number, ctx: Context): void {
    let i = text.indexOf('%');
    while (i >= 0 && i < lineEnd) {
      const a = text.charCodeAt(i + 1), b = text.charCodeAt(i + 2);
      const hex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
      if (!(i + 2 < lineEnd && hex(a) && hex(b))) {
        ctx.report(G.percentEscapeInvalid, i, i + 1, '`%` is not followed by two hexadecimal digits', {
          hint: 'write a literal percent sign as `%25`',
        });
        return; // one report per line
      }
      i = text.indexOf('%', i + 3);
    }
  }

  // ------------------------------------------------------------------ column 9

  /** Check the attributes in `text[s, e)`. Returns false when the column is not GFF3 at all. */
  private attributes(text: string, s: number, e: number, seqid: string, ctx: Context): boolean {
    const firstEq = text.indexOf('=', s);
    if ((firstEq < 0 || firstEq >= e || text.lastIndexOf(' ', firstEq) >= s || text.lastIndexOf('"', firstEq) >= s) && looksLikeGtfAttributes(text.slice(s, e))) {
      const m = /^\s*(\S+)\s+("[^"]*"|[^\s;]+)/.exec(text.slice(s, e))!;
      const key = m[1]!, val = m[2]!.replace(/^"|"$/g, '');
      ctx.report(G.gtfStyleAttributes, s, Math.min(e, s + m[0].length), `attributes are written as \`${show(key)} "${show(val, 24)}";\`, the GTF/GFF2 style, not as \`tag=value\``, {
        hint: this.features <= 1 || !this.versionSeen
          ? 'the file is GTF or GFF2, not GFF3: check it with `--type gtf`, or convert it with `gffread in.gtf -o out.gff3`'
          : `in GFF3 this is \`${key === 'gene_id' || key === 'transcript_id' ? 'ID' : key}=${val}\`; convert the file with \`gffread\` or AGAT rather than by hand`,
      });
      return false;
    }
    const seen = this.seenTags;
    seen.length = 0;
    let open = false;          // inside a quoted value that a semicolon cut in two
    let spaceReported = false;
    let lowerId = -1, lowerParent = -1;
    let i = s;
    while (i < e) {
      let j = text.indexOf(';', i);
      if (j < 0 || j > e) j = e;
      const from = i;
      i = j + 1;
      if (open) { if (text.lastIndexOf('"', j - 1) >= from) open = false; continue; }
      let k = from;
      while (k < j && text.charCodeAt(k) === 32) k++;
      if (k === j) continue; // nothing between two semicolons, or a trailing semicolon
      const eq = text.indexOf('=', k);
      if (eq < 0 || eq >= j) {
        const piece = text.slice(k, j);
        ctx.report(G.attributeMalformed, k, j, `attribute \`${show(piece)}\` has no \`=\``, {
          hint: from > s
            ? 'if this text belongs to the value before it, the semicolon between them must be written `%3B`; otherwise write it as `tag=value`'
            : 'attributes are `tag=value` pairs separated by semicolons, e.g. `ID=gene1;Name=abcA`; write `.` if there are none',
        });
        continue;
      }
      if (eq === k) {
        ctx.report(G.attributeMalformed, k, j, `attribute \`${show(text.slice(k, j))}\` has no tag before \`=\``, { hint: 'write it as `tag=value`, or write a literal `=` inside the previous value as `%3D`' });
        continue;
      }
      if (k > from && !spaceReported) {
        spaceReported = true;
        ctx.report(G.attributeWhitespace, from, k, `space before the tag \`${show(text.slice(k, eq))}\``, {
          hint: 'separate attributes with `;` alone: parsers that keep the space do not recognise the tag',
        });
      }
      const tag = text.slice(k, eq);
      if (seen.length && seen.includes(tag)) {
        ctx.report(G.attributeDuplicate, k, eq, `attribute \`${show(tag)}\` appears twice on this line`, {
          hint: RESERVED.includes(tag) && !['Parent', 'Alias', 'Note', 'Dbxref', 'Ontology_term'].includes(tag) ? `\`${tag}\` takes a single value: keep one` : `write the values once, separated by commas: \`${show(tag)}=value1,value2\``,
        });
      }
      seen.push(tag);
      const v = eq + 1;
      if (v === j) {
        ctx.report(G.attributeValueEmpty, k, j, `attribute \`${show(tag)}\` has no value`, {
          hint: tag === 'ID' || tag === 'Parent' ? `give the ${tag === 'ID' ? 'identifier' : 'ID of the parent feature'}, or remove \`${tag}=\`` : 'leave the attribute out when there is nothing to say',
        });
        continue;
      }
      // Quoted values: quotes are literal in GFF3 and do not protect a semicolon.
      if (text.charCodeAt(v) === 34) {
        const closed = j - 1 > v && text.charCodeAt(j - 1) === 34;
        if (!closed && j < e && text.indexOf('"', v + 1) > j) {
          open = true;
          const close = text.indexOf('"', j);
          ctx.report(G.quotedValueSplit, j, j + 1, `the semicolon inside the quoted value of \`${show(tag)}\` ends the attribute here`, {
            hint: 'quotes do not protect a semicolon in GFF3: write it as `%3B` and remove the quotes',
            notes: [`the value is cut to \`${show(text.slice(v, j))}\`; \`${show(text.slice(j + 1, Math.min(e, close + 1)).trim())}\` becomes a separate attribute`],
          });
        } else if (closed) {
          ctx.report(G.quotedValue, v, j, `the value of \`${show(tag)}\` is wrapped in double quotes`, {
            hint: 'remove the quotes: GFF3 keeps them as part of the value',
          });
        }
      }
      const c = text.charCodeAt(k);
      if (c >= 65 && c <= 90) {
        switch (tag) {
          case 'ID':
            this.idS = v; this.idE = j;
            this.singleValue(text, tag, v, j, ctx);
            break;
          case 'Parent':
            this.parS = v; this.parE = j;
            break;
          case 'Name': case 'Derives_from':
            this.singleValue(text, tag, v, j, ctx);
            break;
          case 'Target':
            if (!this.singleValue(text, tag, v, j, ctx)) this.target(text.slice(v, j), v, ctx);
            break;
          case 'Gap': {
            const gap = text.slice(v, j);
            if (!RE_GAP.test(gap)) {
              const cigar = /^(?:\d+[MIDFRNSHPX=])+$/.test(gap);
              ctx.report(G.gapInvalid, v, j, `Gap \`${show(gap)}\` is not a list of operations such as \`M210 D12 M238\``, {
                hint: cigar
                  ? `this is written like a SAM CIGAR string; in GFF3 the letter comes first and operations are separated by spaces: \`${gap.replace(/(\d+)([A-Z=])/g, '$2$1 ').trim()}\``
                  : 'each operation is one of M, I, D, F, R followed by a length, separated by single spaces',
              });
            }
            break;
          }
          case 'Is_circular': {
            const val = text.slice(v, j);
            if (val === 'true') { this.circularSeqids.add(seqid); this.circular = true; }
            else if (val !== 'false') {
              ctx.report(G.isCircularInvalid, v, j, `Is_circular value \`${show(val)}\` is not \`true\``, {
                hint: /^(true|yes|1|t|y)$/i.test(val) ? 'write `Is_circular=true`, in lower case' : 'write `Is_circular=true` on the feature that represents a circular chromosome or plasmid, and leave the attribute out otherwise',
              });
            }
            break;
          }
          case 'Alias': case 'Note': case 'Dbxref': case 'Ontology_term':
            break;
          default: {
            const lower = tag.toLowerCase();
            const known = RESERVED.find((r) => r.toLowerCase() === lower || r.toLowerCase().replace('_', '') === lower.replace(/[_-]/g, ''));
            ctx.report(G.reservedTagUnknown, k, eq, `attribute \`${show(tag)}\` starts with an upper-case letter but is not a tag the specification defines`, {
              hint: known ? `tags are case-sensitive: the defined tag is \`${known}\`` : `rename it to start with a lower-case letter, e.g. \`${tag[0]!.toLowerCase() + tag.slice(1)}\`; upper-case initials are reserved for ${RESERVED.slice(0, 4).join(', ')} and the other defined tags`,
            });
          }
        }
      } else if (c === 105 /* i */ && tag === 'id') lowerId = k;
      else if (c === 112 /* p */ && tag === 'parent') lowerParent = k;
      if (this.strictEscapes) {
        let x = text.indexOf('=', v);
        if (x < 0 || x >= j) { x = text.indexOf('&', v); if (x >= j) x = -1; }
        if (x >= 0) {
          const ch = text[x]!;
          ctx.report(G.unescapedCharacter, x, x + 1, `unescaped \`${ch}\` in the value of \`${show(tag)}\``, { hint: `write it as \`${ch === '=' ? '%3D' : '%26'}\`` });
        }
      }
    }
    if (lowerId >= 0 && this.idS < 0) {
      ctx.report(G.reservedTagCase, lowerId, lowerId + 2, 'attribute `id` is not the reserved tag `ID`: this feature has no identifier', {
        hint: 'write `ID=` in upper case; tags are case-sensitive, so no parser treats `id` as the feature ID',
      });
    }
    if (lowerParent >= 0 && this.parS < 0) {
      ctx.report(G.reservedTagCase, lowerParent, lowerParent + 6, 'attribute `parent` is not the reserved tag `Parent`: this feature is not linked to a parent', {
        hint: 'write `Parent=` with a capital P; tags are case-sensitive, so no parser treats `parent` as the link to the parent feature',
      });
    }
    return true;
  }

  /** Report a comma in a tag that takes one value. Returns true if it did. */
  private singleValue(text: string, tag: string, v: number, j: number, ctx: Context): boolean {
    const comma = text.indexOf(',', v);
    if (comma < 0 || comma >= j) return false;
    ctx.report(G.multipleValuesNotAllowed, comma, comma + 1, `\`${tag}\` takes a single value, but the comma makes this ${plural(text.slice(v, j).split(',').length, 'value')}`, {
      hint: tag === 'ID' ? 'an ID cannot contain a comma: rename it, or write the comma as `%2C`'
        : tag === 'Target' ? 'a line describes one alignment: give each target its own line, with the same ID if they are parts of one match'
        : 'if the comma is part of the text, write it as `%2C`',
    });
    return true;
  }

  private target(value: string, v: number, ctx: Context): void {
    const p = value.split(' ');
    const ok = (p.length === 3 || p.length === 4) && p[0] !== '' && parsePositiveInt(p[1]!) > 0 && parsePositiveInt(p[2]!) > 0 && (p.length === 3 || p[3] === '+' || p[3] === '-');
    if (ok) {
      const a = parsePositiveInt(p[1]!), b = parsePositiveInt(p[2]!);
      if (a > b) {
        const at = v + p[0]!.length + 1;
        ctx.report(G.targetInvalid, at, at + p[1]!.length + 1 + p[2]!.length, `Target start ${a} is greater than end ${b}`, {
          hint: `write \`${p[0]} ${b} ${a}${p[3] ? ' ' + p[3] : ''}\`: the direction of an alignment is given by the strand, not by swapping the coordinates`,
        });
      }
      return;
    }
    let hint = 'the form is `Target=name start end` with an optional `+` or `-` at the end, separated by single spaces';
    const plus = /^([^+\s]+)\+(\d+)\+(\d+)(?:\+([+-]))?$/.exec(value);
    if (plus) hint = `joining the parts with \`+\` is no longer allowed; write \`Target=${plus[1]} ${plus[2]} ${plus[3]}${plus[4] ? ' ' + plus[4] : ''}\``;
    else if (p.length === 1) hint = 'the start and end of the alignment in the target sequence are missing, e.g. `Target=mrna0042 1 448`';
    else if (/ {2}/.test(value)) hint = 'separate the parts with single spaces';
    else if (p.length > 4) hint = 'a target name that contains spaces must have them written as `%20`';
    ctx.report(G.targetInvalid, v, v + value.length, `Target \`${show(value)}\` is not \`target_id start end [strand]\``, { hint });
  }

  // ------------------------------------------------------------------ ID and Parent

  private relationships(text: string, no: number, type: string, seqid: string, start: number, end: number, ctx: Context): void {
    const ids = this.ids;
    const seq = this.seqCode;
    let entry = -1;
    if (this.idS >= 0) {
      const idS = this.idS, idE = this.idE;
      entry = ids.intern(text, idS, idE);
      const typeCode = this.types.code(type);
      const first = ids.get(LINE, entry);
      if (first === 0) {
        ids.set(LINE, entry, no);
        ids.set(META, entry, (typeCode | (seq << 12)) >>> 0);
        ids.set(START, entry, start > 0 ? start : 0);
        ids.set(END, entry, end > 0 ? end : 0);
        if (!ids.added && this.pending.size > 0) {
          // Children that came first were waiting for this feature.
          const p = this.pending.get(entry);
          if (p) {
            this.pending.delete(entry);
            if (p.seq !== 0 && seq !== 0 && p.seq !== seq) {
              ctx.reportAt(G.parentDifferentSeqid, p.line, `this feature is on \`${show(this.seqids.names[p.seq]!)}\`, but its Parent \`${show(p.name)}\` is on \`${show(seqid)}\``, {
                hint: 'a feature and its parent must be on the same sequence; IDs were probably reused across sequences',
                notes: [`the parent is defined on line ${no}`],
              });
            }
          }
        }
      } else {
        const meta = ids.get(META, entry);
        const type0 = meta & 0xfff, seq0 = meta >>> 12;
        const id = text.slice(idS, idE);
        if (type0 !== typeCode && type0 !== 0 && typeCode !== 0) {
          ctx.report(G.idDuplicate, idS, idE, `ID \`${show(id)}\` is already used by a \`${show(this.types.names[type0]!)}\` feature`, {
            hint: `give this ${show(type)} its own ID; lines may share an ID only when they are the parts of one feature`,
            notes: [`first used on line ${first}`],
          });
          entry = -1; // not the same feature: its Parent links belong to neither
        } else if (seq0 !== seq && seq0 !== 0 && seq !== 0) {
          ctx.report(G.idDuplicate, idS, idE, `ID \`${show(id)}\` is already used by a feature on \`${show(this.seqids.names[seq0]!)}\``, {
            hint: 'IDs must be unique in the whole file, not per sequence: prefix them with the sequence name, or merge files with a tool that renames clashing IDs',
            notes: [`first used on line ${first}`],
          });
          entry = -1;
        } else if (start > 0 && ids.get(START, entry) === start && ids.get(END, entry) === end) {
          ctx.report(G.idRepeatedSameLocation, idS, idE, `ID \`${show(id)}\` is repeated with the same type and location`, {
            hint: 'the feature is written twice: delete one of the lines (was the file concatenated with itself?)',
            notes: [`first on line ${first}`],
          });
        } else if (first < this.terminatorLine) {
          ctx.report(G.closedByTerminator, idS, idE, `ID \`${show(id)}\` continues a feature that the \`###\` on line ${this.terminatorLine} closed`, {
            hint: 'keep all lines of one feature between the same pair of `###` lines, or remove the `###` lines',
            notes: [`the feature starts on line ${first}`],
          });
        }
      }
    }
    if (this.parS < 0) return;
    const parE = this.parE;
    let a = this.parS;
    while (a <= parE) {
      let b = text.indexOf(',', a);
      if (b < 0 || b > parE) b = parE;
      if (b === a) {
        ctx.report(G.attributeValueEmpty, a === this.parS ? a : a - 1, a === this.parS ? a + 1 : a, 'empty entry in the Parent list', { hint: 'remove the extra comma' });
        a = b + 1;
        continue;
      }
      if (entry >= 0 && b - a === this.idE - this.idS && text.startsWith(text.slice(this.idS, this.idE), a)) {
        ctx.report(G.parentCycle, a, b, `feature \`${show(text.slice(a, b))}\` names itself as its Parent`, {
          hint: 'a gene and its transcript need different IDs: give the child its own ID and keep `Parent` pointing at the gene',
        });
        a = b + 1;
        continue;
      }
      const pe = ids.intern(text, a, b);
      const pl = ids.get(LINE, pe);
      if (pl === 0) {
        const p = this.pending.get(pe);
        if (p) p.count++;
        else this.pending.set(pe, { name: text.slice(a, b), line: no, seq, count: 1 });
      } else {
        if (pl < this.terminatorLine) {
          ctx.report(G.closedByTerminator, a, b, `Parent \`${show(text.slice(a, b))}\` was closed by the \`###\` on line ${this.terminatorLine}`, {
            hint: 'a `###` line promises that no later feature refers to those above it: move this feature above it, or remove the `###` lines',
            notes: [`the parent is defined on line ${pl}`],
          });
        }
        const pseq = ids.get(META, pe) >>> 12;
        if (pseq !== 0 && seq !== 0 && pseq !== seq) {
          ctx.report(G.parentDifferentSeqid, a, b, `Parent \`${show(text.slice(a, b))}\` is on \`${show(this.seqids.names[pseq]!)}\`, but this feature is on \`${show(seqid)}\``, {
            hint: 'a feature and its parent must be on the same sequence; IDs were probably reused across sequences',
            notes: [`the parent is defined on line ${pl}`],
          });
        }
      }
      if (entry >= 0) {
        const link = ids.get(LINK, entry) & LINK_MASK;
        if (link === 0) { ids.set(LINK, entry, pe + 1); if (entry < this.blockStart) this.blockOld.push(entry); }
        else if (link - 1 !== pe) {
          const more = this.extraParents.get(entry);
          if (!more) this.extraParents.set(entry, [pe]);
          else if (!more.includes(pe)) more.push(pe);
        }
      }
      a = b + 1;
    }
  }

  /**
   * At a `###` line and at the end of the features: every Parent must have been defined by now, and the Parent
   * links collected since the last flush must not form a cycle. Then the per-block state is released.
   */
  private flush(ctx: Context, atTerminator = false): void {
    if (this.pending.size > 0) {
      for (const p of this.pending.values()) {
        ctx.reportAt(G.parentUnresolved, p.line, `Parent \`${show(p.name)}\` is not the ID of any feature` + (atTerminator || this.terminatorLine > 0 ? ' in this block' : ' in the file'), {
          hint: atTerminator || this.terminatorLine > 0
            ? 'a parent must be defined between the same `###` lines as its children; check the spelling and case of the ID, or remove misplaced `###` lines'
            : 'check the spelling and the case of the ID; if the file was filtered or cut from a larger one, the parent line was probably removed',
          notes: p.count > 1 ? [`${plural(p.count, 'feature')} refer to it`] : [],
        });
      }
      this.pending.clear();
    }
    const ids = this.ids;
    const from = this.blockStart, to = ids.size, old = this.blockOld;
    const stack: number[] = [];
    const next: number[] = [];
    // Depth-first walk along the Parent links made since the last flush. State 1 = on the current path, 2 = done.
    for (let r = from - old.length; r < to; r++) {
      const root = r < from ? old[r - (from - old.length)]! : r;
      const first = ids.get(LINK, root);
      if (first === 0 || first >>> 30 !== 0) continue;
      stack.push(root); next.push(0);
      ids.set(LINK, root, (first | (1 << 30)) >>> 0);
      while (stack.length > 0) {
        const top = stack.length - 1;
        const e = stack[top]!;
        const k = next[top]!++;
        let p = -1;
        if (k === 0) p = (ids.get(LINK, e) & LINK_MASK) - 1;
        else { const more = this.extraParents.get(e); if (more && k - 1 < more.length) p = more[k - 1]!; }
        if (p < 0) {
          ids.set(LINK, e, ((ids.get(LINK, e) & LINK_MASK) | (2 << 30)) >>> 0);
          stack.pop(); next.pop();
          continue;
        }
        const link = ids.get(LINK, p);
        const state = link >>> 30;
        if (state === 1) {
          const path = stack.slice(stack.lastIndexOf(p)).map((x) => ids.get(LINE, x));
          ctx.reportAt(G.parentCycle, ids.get(LINE, p), `Parent relationships form a cycle through the features on lines ${path.join(', ')}`, {
            hint: 'follow the `Parent` values from this line: one of them points back at a feature that is its own descendant',
          });
        } else if (state === 0 && (link & LINK_MASK) !== 0) {
          stack.push(p); next.push(0);
          ids.set(LINK, p, (link | (1 << 30)) >>> 0);
        }
      }
    }
    for (let e = from; e < to; e++) if (ids.get(LINK, e) !== 0) ids.set(LINK, e, 0);
    for (const e of old) ids.set(LINK, e, 0);
    old.length = 0;
    this.blockStart = to;
    this.extraParents.clear();
  }
}

export const gff3: FormatDef = {
  id: 'gff3',
  name: 'GFF3',
  description: 'Generic Feature Format version 3',
  extensions: ['.gff3', '.gff'],
  rules: Object.values(G),
  sniff: sniffGff3,
  create(ctx) { return new Gff3Validator(ctx); },
};
