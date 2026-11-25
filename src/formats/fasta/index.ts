import type { Context, FormatDef, Line, Validator } from '../../core/types.ts';
import { plural, show } from '../../core/util.ts';
import { F, F_UNLISTED } from './rules.ts';

// ---------------------------------------------------------------------------------------------- byte classes

/** Never a residue in any alphabet: whitespace, digits, `>`, punctuation other than `-` and `*`, non-ASCII, controls. */
const BAD = 1;
/** A letter that is not a nucleotide code (E F I J L O P Q Z). `X` is left alone: some maskers write it into DNA. */
const NOT_NUC = 2;
const HAS_T = 4;
const HAS_U = 8;

const FLAGS = new Uint8Array(256).fill(BAD);
/** 1 for the unambiguous nucleotide letters A C G T U N, used to tell nucleotide from protein. */
const CORE = new Uint8Array(256);
const LETTER = new Uint8Array(256);
/** Slow-path classification of BAD bytes. */
const K_OK = 0, K_SPACE = 1, K_DIGIT = 2, K_GT = 3, K_SYMBOL = 4, K_CONTROL = 5;
const KIND = new Uint8Array(256).fill(K_SYMBOL);
{
  const both = (letters: string, f: (code: number) => void) => { for (const ch of letters) { f(ch.charCodeAt(0)); f(ch.toLowerCase().charCodeAt(0)); } };
  both('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (c) => { FLAGS[c] = 0; KIND[c] = K_OK; LETTER[c] = 1; });
  both('EFIJLOPQZ', (c) => { FLAGS[c] = NOT_NUC; });
  both('T', (c) => { FLAGS[c] = HAS_T; });
  both('U', (c) => { FLAGS[c] = HAS_U; });
  both('ACGTUN', (c) => { CORE[c] = 1; });
  for (const ch of '-*') { FLAGS[ch.charCodeAt(0)] = 0; KIND[ch.charCodeAt(0)] = K_OK; }
  KIND[32] = K_SPACE; KIND[9] = K_SPACE;
  for (let c = 48; c <= 57; c++) KIND[c] = K_DIGIT;
  KIND[62] = K_GT;
  // Control characters are reported by the engine (TXT007); do not report them a second time.
  for (let c = 0; c < 32; c++) if (c !== 9) KIND[c] = K_CONTROL;
  KIND[127] = K_CONTROL;
}

/** Letters sampled before the alphabet of the file is considered settled. */
const SAMPLE_LETTERS = 4096;
/** At most this many individual characters are reported per line (or per piece of a very long line). */
const PER_LINE = 8;
/**
 * Identifiers remembered for duplicate detection. This is the one structure that grows with the file: a Map entry
 * (key, line number) plus a one-byte-per-character string. Measured on Node 24: 77 MB of live heap for one million
 * 30-character identifiers; the process peaks at about 350 MB resident while the Map is rehashed on its way there.
 * Beyond the cap later records are still looked up but no longer added, and FA017 says so.
 */
const MAX_IDS = 1_000_000;
/** Longer identifiers are not remembered at all (they would dominate the memory budget). */
const MAX_ID_BYTES = 255;

const SYMBOL_HINT: Record<string, string> = {
  '.': '`.` is the gap symbol of A2M/Stockholm alignments; FASTA alignments use `-`',
  '~': '`~` is the gap symbol of GCG/MSF alignments; FASTA alignments use `-`',
  '?': '`?` marks missing data in NEXUS/PHYLIP; use `N` for an unknown base or `X` for an unknown amino acid',
  '_': 'use `-` for an alignment gap',
  '&': '`&` joins two strands in ViennaRNA (RNAcofold) input; other tools do not understand it',
  ',': 'remove the punctuation; sequence lines hold residue codes only',
  '@': 'a line starting with `@` suggests FASTQ records mixed into this file',
  '+': 'a line starting with `+` suggests FASTQ records mixed into this file',
};

type Alphabet = 'auto' | 'dna' | 'rna' | 'protein';

class FastaValidator implements Validator {
  private readonly forced: Alphabet;
  private readonly maxIds: number;

  // file
  private records = 0;
  private residues = 0;
  private preHeaderReported = false;
  // alphabet detection: cumulative counts over the first SAMPLE_LETTERS letters
  private sampleCore = 0;
  private sampleLetters = 0;
  /** 0 = still sampling, 1 = nucleotide, 2 = protein or mixed (letters are no longer checked). */
  private locked = 0;
  private switchReported = false;
  // identifiers
  private readonly ids = new Map<string, number>();
  private idsCappedAt = 0;
  private idFilter: Uint32Array | null = null;
  // current record
  private headerLine = 0;
  private curId = '';
  private inHeader = false;       // a header (or other non-sequence line) longer than one piece is still arriving
  private seqLen = 0;
  private recFlags = 0;
  private tuReported = false;
  private firstWidth = -1;        // length of the record's first sequence line
  private lineWidth = 0;          // length so far of the line that is arriving in pieces
  private shortLine = 0;          // line number of a line shorter than the first one
  private shortWidth = 0;
  private unevenReported = false;
  // blank lines that have been seen and not yet classified
  private blankCount = 0;
  private blankLine = 0;
  private blankHasSpaces = false;

  constructor(ctx: Context) {
    const a = ctx.options['alphabet'];
    this.forced = a === 'dna' || a === 'rna' || a === 'protein' ? a : 'auto';
    const m = ctx.options['maxIds'];
    this.maxIds = typeof m === 'number' && m >= 0 ? m : MAX_IDS;
    if (this.forced === 'protein') this.locked = 2;
    else if (this.forced !== 'auto') this.locked = 1;
  }

  line(line: Line, ctx: Context): void {
    const b = line.bytes;
    const n = b.length;
    if (line.continued) {
      // A further piece of a line longer than the engine's piece size (the last piece can be empty).
      if (this.inHeader) { if (!line.partial) this.inHeader = false; return; }
      if (this.records > 0) this.sequence(b, n, line, ctx);
      return;
    }
    if (n === 0) {
      // The engine only delivers an empty line when content follows it.
      if (this.blankCount++ === 0) { this.blankLine = line.no; this.blankHasSpaces = false; }
      return;
    }
    const c0 = b[0]!;
    if (c0 === 62) { this.header(b, n, line, ctx); return; }
    if (c0 === 59 || c0 === 35) {
      this.flushBlank(ctx, this.records > 0 && this.seqLen > 0 ? 'inside' : 'between');
      this.inHeader = line.partial;
      ctx.report(F.commentLine, 0, line.partial ? 1 : n, `comment line starting with \`${String.fromCharCode(c0)}\``, {
        hint: 'delete the line, or move its text into the description after `>id`; tools read it as sequence or stop',
      });
      return;
    }
    if (this.records === 0) { this.inHeader = line.partial; this.beforeHeader(b, n, line, ctx); return; }
    this.sequence(b, n, line, ctx);
  }

  end(ctx: Context): void {
    if (this.records > 0) this.finishRecord(ctx);
    if (this.blankCount > 0) this.flushBlank(ctx, 'end');
    ctx.stat('sequences', this.records);
    ctx.stat('residues', this.residues);
    const nucleotide = this.locked === 1 || (this.locked === 0 && this.sampleLetters > 0 && this.sampleCore * 10 >= this.sampleLetters * 9);
    ctx.stat('alphabet', this.forced !== 'auto' ? this.forced : this.sampleLetters === 0 ? 'unknown' : this.switchReported ? 'mixed' : nucleotide ? 'nucleotide' : 'protein');
    if (this.idsCappedAt > 0) {
      ctx.reportAt(F_UNLISTED.idTrackingCapped, 0,
        `duplicate identifiers were checked against the first ${plural(this.ids.size, 'record')} only (${plural(this.records, 'record')} in total)`, {
          hint: 'for a complete check run `seqkit rmdup -D dup.txt file.fa > /dev/null` and look at dup.txt',
          notes: [`identifiers stopped being remembered at line ${this.idsCappedAt}`],
        });
    }
  }

  // ------------------------------------------------------------------------------------------ record structure

  private header(b: Uint8Array, n: number, line: Line, ctx: Context): void {
    if (this.records > 0) this.finishRecord(ctx);
    if (this.blankCount > 0) this.flushBlank(ctx, 'between');
    this.records++;
    this.headerLine = line.no;
    this.inHeader = line.partial;
    this.seqLen = 0; this.recFlags = 0; this.tuReported = false;
    this.firstWidth = -1; this.lineWidth = 0; this.shortLine = 0; this.unevenReported = false;
    this.curId = '';

    let s = 1;
    while (s < n && (b[s] === 32 || b[s] === 9)) s++;
    if (s >= n) {
      ctx.report(F.headerEmpty, 0, n, n === 1 ? 'header is a bare `>` with no identifier' : 'header has only whitespace after `>`', {
        hint: 'give the sequence a name: `>seq1 optional description`',
      });
      return;
    }
    let e = s;
    while (e < n && b[e] !== 32 && b[e] !== 9) e++;
    if (s > 1) {
      ctx.report(F.headerLeadingWhitespace, 1, s, `${s === 2 ? 'whitespace' : plural(s - 1, 'whitespace character')} between \`>\` and the identifier \`${show(line.text.slice(s, e))}\``, {
        hint: `write \`>${show(line.text.slice(s, e))}\`: samtools skips the space, but other parsers read an empty identifier`,
        fix: { title: 'Remove the whitespace after >', edits: [{ line: line.no, column: 2, endColumn: s + 1, text: '' }] },
      });
    }
    if (e - s > MAX_ID_BYTES) { this.curId = show(line.text.slice(s, s + 48)); return; }
    if (this.idFilter) {
      // The Map is full. Most later identifiers are new: the filter says so without allocating a string per record.
      let h = 0x811c9dc5;
      for (let i = s; i < e; i++) h = Math.imul(h ^ b[i]!, 16777619);
      h >>>= 8;
      if (!(this.idFilter[h >>> 5]! & (1 << (h & 31)))) return;
    }
    // Built from the bytes so the Map does not keep the whole header line alive through a sliced string.
    const id = String.fromCharCode.apply(null, b.subarray(s, e) as unknown as number[]);
    this.curId = id;
    const prev = this.ids.get(id);
    if (prev !== undefined) {
      ctx.report(F.duplicateId, s, e, `identifier \`${show(id)}\` was already used on line ${prev}`, {
        hint: 'make the identifiers unique (the description after the first space does not count); `seqkit rename` appends a suffix to repeats',
        notes: [`first used on line ${prev}`],
      });
    } else if (this.ids.size < this.maxIds) {
      this.ids.set(id, line.no);
    } else if (this.idsCappedAt === 0) {
      this.idsCappedAt = line.no;
      // 2^24 bits (2 MB), one per remembered identifier, indexed by a 24-bit hash of its bytes.
      const filter = new Uint32Array(1 << 19);
      for (const key of this.ids.keys()) {
        let h = 0x811c9dc5;
        for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
        h >>>= 8;
        filter[h >>> 5]! |= 1 << (h & 31);
      }
      this.idFilter = filter;
    }
  }

  private finishRecord(ctx: Context): void {
    if (this.seqLen === 0) {
      ctx.reportAt(F.sequenceEmpty, this.headerLine, `record ${this.name()} has no sequence`, {
        hint: 'remove the header, or restore the missing sequence; `seqkit seq -m 1` drops empty records',
      });
    }
  }

  private name(): string {
    return this.curId ? `\`${show(this.curId)}\`` : `on line ${this.headerLine}`;
  }

  /** Report the blank lines seen since the last content line, now that what follows them is known. */
  private flushBlank(ctx: Context, where: 'inside' | 'between' | 'end'): void {
    const k = this.blankCount;
    if (k === 0) return;
    this.blankCount = 0;
    const what = (this.blankHasSpaces ? (k === 1 ? 'line containing only whitespace' : `${k} lines containing only whitespace`) : plural(k, 'blank line'));
    if (where === 'inside') {
      ctx.reportAt(F.blankLineInSequence, this.blankLine, `${what} inside the sequence of ${this.name()}`, {
        hint: 'delete the blank line; if a new record starts after it, its `>` header line is missing',
      });
    } else {
      ctx.reportAt(F.blankLineBetweenRecords, this.blankLine, where === 'end' ? `${what} at the end of the file` : this.records === 0 ? `${what} before the first record` : `${what} before the next header`, {
        hint: 'remove empty lines with `sed -i \'/^[[:space:]]*$/d\' file.fa`',
      });
    }
  }

  private beforeHeader(b: Uint8Array, n: number, line: Line, ctx: Context): void {
    if (this.preHeaderReported) return;
    // A whitespace-only line is a blank line, not data.
    let i = 0;
    while (i < n && (b[i] === 32 || b[i] === 9)) i++;
    if (i === n) { this.noteSpaceLine(line); return; }
    this.preHeaderReported = true;
    this.blankCount = 0;
    const text = line.text;
    const c0 = b[0]!;
    let hint = 'every record starts with a `>name` line; add one above this line';
    if (c0 === 64) hint = 'a first line starting with `@` suggests FASTQ: check it with `--type fastq`, or convert with `seqtk seq -A in.fq > out.fa`';
    else if (/^LOCUS\s/.test(text)) hint = 'this is a GenBank flat file; convert it with EMBOSS `seqret` or Biopython `SeqIO.convert("in.gb", "genbank", "out.fa", "fasta")`';
    else if (/^ID\s{3}/.test(text)) hint = 'this is an EMBL/UniProt flat file; convert it with EMBOSS `seqret` or Biopython `SeqIO.convert`';
    else if (/^(CLUSTAL|MUSCLE|#NEXUS|# STOCKHOLM)/i.test(text)) hint = 'this is an alignment in another format; convert it with EMBOSS `seqret` or Biopython `AlignIO.convert`';
    else if (i > 0 && b[i] === 62) hint = 'the `>` is preceded by whitespace; it must be the first character of the line';
    ctx.report(F.dataBeforeHeader, 0, Math.min(n, 60), `line \`${show(text, 32)}\` comes before any \`>\` header`, { hint });
  }

  private noteSpaceLine(line: Line): void {
    if (this.blankCount++ === 0) this.blankLine = line.no;
    this.blankHasSpaces = true;
  }

  // ------------------------------------------------------------------------------------------ sequence lines

  private sequence(b: Uint8Array, n: number, line: Line, ctx: Context): void {
    let acc = 0;
    for (let i = 0; i < n; i++) acc |= FLAGS[b[i]!]!;

    let counted = n;
    if (acc & BAD) {
      if (!line.continued && !line.partial && onlySpaces(b, n)) { this.noteSpaceLine(line); return; }
      if (this.blankCount > 0 && !line.continued) this.flushBlank(ctx, 'inside');
      const gt = b.indexOf(62);
      if (gt >= 0) {
        // What follows the `>` is the header of a swallowed record, not sequence: check only what precedes it.
        ctx.report(F.headerMarkerInSequence, gt, gt + 1, `\`>\` in the middle of a sequence line, before \`${show(line.text.slice(gt + 1), 24)}\``, {
          hint: 'a line break is missing before `>`: the previous file probably did not end with a newline when files were concatenated',
          ...(line.continued ? {} : { fix: { title: 'Start a new line before >', edits: [{ line: line.no, column: gt + 1, endColumn: gt + 1, text: '\n' }] } }),
        });
        this.unevenReported = true;
        b = b.subarray(0, gt); n = gt; counted = n; acc = 0;
        for (let i = 0; i < n; i++) acc |= FLAGS[b[i]!]!;
      }
      if (acc & BAD) counted -= this.reportBad(b, n, line, ctx);
    } else if (this.blankCount > 0 && !line.continued) {
      this.flushBlank(ctx, 'inside');
    }

    // Alphabet: nucleotide when at least 90% of the letters seen so far are A, C, G, T, U or N.
    if (this.locked === 0) {
      let core = 0, letters = 0;
      for (let i = 0; i < n; i++) { const c = b[i]!; core += CORE[c]!; letters += LETTER[c]!; }
      this.sampleCore += core; this.sampleLetters += letters;
    }
    const nucleotide = this.locked === 1 || (this.locked === 0 && this.sampleLetters > 0 && this.sampleCore * 10 >= this.sampleLetters * 9);
    if (nucleotide) {
      if (this.forced === 'dna' ? acc & (NOT_NUC | HAS_U) : this.forced === 'rna' ? acc & (NOT_NUC | HAS_T) : acc & NOT_NUC) this.reportLetters(b, n, line, ctx);
      else if (this.forced === 'auto' && !this.tuReported && ((this.recFlags | acc) & (HAS_T | HAS_U)) === (HAS_T | HAS_U)) this.reportMixedTU(b, n, line, ctx);
    }
    if (this.locked === 0 && this.sampleLetters >= SAMPLE_LETTERS) this.locked = nucleotide ? 1 : 2;

    this.recFlags |= acc;
    this.seqLen += counted;
    this.residues += counted;

    // Line lengths, as `samtools faidx` needs them: all equal within a record, the last may be shorter.
    this.lineWidth += n;
    if (line.partial) return;
    const w = this.lineWidth;
    this.lineWidth = 0;
    if (this.firstWidth < 0) { this.firstWidth = w; return; }
    if (this.unevenReported) return;
    if (this.shortLine > 0) {
      this.unevenReported = true;
      ctx.reportAt(F.lineLengthUneven, this.shortLine,
        `line has ${plural(this.shortWidth, 'character')} but the other lines of ${this.name()} have ${this.firstWidth}, and it is not the last line of the record`, {
          hint: 're-wrap the file, e.g. `seqkit seq -w 60 in.fa > out.fa`; `samtools faidx` fails with "Different line length in sequence"',
        });
    } else if (w > this.firstWidth) {
      this.unevenReported = true;
      const whole = line.continued;
      ctx.report(F.lineLengthUneven, whole ? -1 : this.firstWidth, whole ? -1 : n,
        `line has ${plural(w, 'character')} but the first sequence line of ${this.name()} has ${this.firstWidth}`, {
          hint: 're-wrap the file, e.g. `seqkit seq -w 60 in.fa > out.fa`; `samtools faidx` fails with "Different line length in sequence"',
        });
    } else if (w < this.firstWidth) {
      this.shortLine = line.no; this.shortWidth = w;
    }
  }

  /** Report characters that are residues in no alphabet. Returns how many bytes of the line are not residues. */
  private reportBad(b: Uint8Array, n: number, line: Line, ctx: Context): number {
    let spaces = 0, digits = 0, firstSpace = -1, firstDigit = -1, lastNonSpace = -1, bad = 0;
    for (let i = 0; i < n; i++) {
      const k = KIND[b[i]!]!;
      if (k === K_SPACE) { spaces++; if (firstSpace < 0) firstSpace = i; continue; }
      lastNonSpace = i;
      if (k === K_DIGIT) { digits++; if (firstDigit < 0) firstDigit = i; }
      if (k !== K_OK) bad++;
    }
    bad += spaces;
    const text = line.text;

    if (digits > 0 && spaces > 0) {
      // Position numbers and blocks of ten: one diagnostic for the whole line.
      let e = firstDigit;
      while (e < n && KIND[b[e]!] === K_DIGIT) e++;
      ctx.report(F.sequenceDigits, firstDigit, e, `sequence line contains the number \`${show(text.slice(firstDigit, e))}\` and ${plural(spaces, 'space')}: it was pasted from a numbered listing`, {
        hint: 'strip the position numbers and spaces from the sequence lines: `sed -i \'/^>/! s/[0-9 \\t]//g\' file.fa`',
      });
    } else if (digits > 0) {
      let shown = 0;
      for (let i = firstDigit; i < n && shown < PER_LINE; i++) {
        if (KIND[b[i]!] !== K_DIGIT) continue;
        let e = i;
        while (e < n && KIND[b[e]!] === K_DIGIT) e++;
        ctx.report(F.sequenceDigits, i, e, `${e - i === 1 ? 'digit' : 'digits'} \`${show(text.slice(i, e))}\` in the sequence`, {
          hint: 'remove the digits; if they stand for unknown residues write `N` (nucleotide) or `X` (protein)',
        });
        shown++; i = e;
      }
    } else if (spaces > 0) {
      if (firstSpace > lastNonSpace) {
        ctx.report(F.sequenceWhitespace, firstSpace, n, `${plural(n - firstSpace, 'whitespace character')} at the end of the sequence line`, {
          hint: 'strip trailing whitespace: `sed -i \'s/[ \\t]*$//\' file.fa`',
          // Columns of a later piece of a very long line are not known here, so no fix is offered for those.
          ...(line.continued ? {} : { fix: { title: 'Remove trailing whitespace', edits: [{ line: line.no, column: firstSpace + 1, endColumn: n + 1, text: '' }] } }),
        });
      } else {
        let e = firstSpace;
        while (e < n && KIND[b[e]!] === K_SPACE) e++;
        ctx.report(F.sequenceWhitespace, firstSpace, e, `${plural(spaces, 'whitespace character')} inside the sequence line`, {
          hint: 'remove spaces and tabs from the sequence lines: `sed -i \'/^>/! s/[ \\t]//g\' file.fa`',
        });
      }
    }

    let shown = 0;
    for (let i = 0; i < n && shown < PER_LINE; i++) {
      const c = b[i]!;
      const k = KIND[c]!;
      if (k === K_SYMBOL) {
        let len = 1;
        if (c >= 0x80) { while (i + len < n && (b[i + len]! & 0xc0) === 0x80) len++; }
        const ch = text.slice(i, i + len);
        ctx.report(F.nonResidueCharacter, i, i + len, `\`${show(ch)}\` is not a residue code`, {
          hint: SYMBOL_HINT[ch] ?? 'remove it; besides letters only `-` (gap) and `*` (stop) appear in FASTA sequences',
        });
        shown++; i += len - 1;
      }
    }
    return bad;
  }

  /** Letters that are not nucleotide codes, in a file that is (so far) nucleotide. */
  private reportLetters(b: Uint8Array, n: number, line: Line, ctx: Context): void {
    const mask = this.forced === 'dna' ? NOT_NUC | HAS_U : this.forced === 'rna' ? NOT_NUC | HAS_T : NOT_NUC;
    let wrong = 0, letters = 0;
    for (let i = 0; i < n; i++) { const c = b[i]!; if (FLAGS[c]! & mask) wrong++; letters += LETTER[c]!; }
    // One or two odd letters in a line of bases are typing errors; a line made of them is not nucleotide sequence.
    if (this.forced === 'auto' && wrong * 10 > letters && (wrong > 2 || letters < 8)) {
      // The line as a whole is not nucleotide sequence. Reporting each letter would bury the real finding.
      if (this.locked === 1) {
        this.locked = 2;
        this.switchReported = true;
        ctx.report(F.alphabetSwitch, -1, -1, `${this.name()} looks like protein, but the file so far holds nucleotide sequences`, {
          hint: 'keep nucleotide and protein sequences in separate files; letters are not checked against the nucleotide codes from here on',
          notes: [`${wrong} of the ${letters} letters on this line are not nucleotide codes`],
        });
      }
      return;
    }
    let shown = 0;
    for (let i = 0; i < n && shown < PER_LINE; i++) {
      const c = b[i]!;
      const f = FLAGS[c]!;
      if (!(f & mask)) continue;
      const ch = String.fromCharCode(c);
      if (f & NOT_NUC) {
        ctx.report(F.invalidResidue, i, i + 1, `\`${ch}\` is not a nucleotide code`, {
          hint: 'nucleotide codes are A C G T U, N and the ambiguity codes R Y K M S W B D H V; replace an unknown base with `N`' +
            (this.forced === 'auto' ? ' (if this is a protein file, pass `-o fasta.alphabet=protein`)' : ''),
        });
      } else {
        ctx.report(F.invalidResidue, i, i + 1, `\`${ch}\` in a sequence declared as ${this.forced === 'dna' ? 'DNA' : 'RNA'}`, {
          hint: this.forced === 'dna' ? 'DNA is written with `T`; convert with `seqkit seq --rna2dna`' : 'RNA is written with `U`; convert with `seqkit seq --dna2rna`',
        });
      }
      shown++;
    }
  }

  private reportMixedTU(b: Uint8Array, n: number, line: Line, ctx: Context): void {
    this.tuReported = true;
    // Point at the letter that arrived second: the first occurrence on this line of whichever kind is new.
    const had = this.recFlags & (HAS_T | HAS_U);
    let want = had === HAS_T ? HAS_U : had === HAS_U ? HAS_T : 0;
    let at = -1;
    for (let i = 0; i < n; i++) {
      const f = FLAGS[b[i]!]! & (HAS_T | HAS_U);
      if (!f) continue;
      if (want === 0) { want = f === HAS_T ? HAS_U : HAS_T; continue; }
      if (f === want) { at = i; break; }
    }
    if (at < 0) return;
    const ch = String.fromCharCode(b[at]!);
    const other = want === HAS_U ? 'T' : 'U';
    ctx.report(F.mixedUracilThymine, at, at + 1, `\`${ch}\` in a sequence that also contains \`${other}\``, {
      hint: 'write the whole sequence as DNA (`seqkit seq --rna2dna`) or as RNA (`seqkit seq --dna2rna`)',
    });
  }
}

function onlySpaces(b: Uint8Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (b[i] !== 32 && b[i] !== 9) return false;
  return true;
}

export const fasta: FormatDef = {
  id: 'fasta',
  name: 'FASTA',
  description: 'FASTA nucleotide and protein sequences',
  extensions: ['.fasta', '.fa', '.fna', '.ffn', '.frn', '.faa', '.fas', '.mfa'],
  segments: true,
  rules: [...Object.values(F), ...Object.values(F_UNLISTED)],
  sniff(head) {
    const first = head.find((l) => l.trim() !== '') ?? '';
    if (first.startsWith('>')) return 0.9;
    // A legacy comment line in front of the first record.
    if (first.startsWith(';') && head.some((l) => l.startsWith('>'))) return 0.5;
    return 0;
  },
  create(ctx) { return new FastaValidator(ctx); },
};
