// Code shared by the GFF3 and GTF validators: both are nine-column, tab-separated feature tables that differ
// mainly in column 9 and in what the eighth column is called.
import type { Context, RuleMeta } from '../../core/types.ts';
import { plural, show } from '../../core/util.ts';

// ---------------------------------------------------------------------------------------------- columns

/** Split a line on tabs into reusable arrays. Returns the number of fields. */
export function splitTabs(text: string, fields: string[], starts: number[]): number {
  let n = 0;
  let pos = 0;
  for (;;) {
    const i = text.indexOf('\t', pos);
    starts[n] = pos;
    if (i < 0) { fields[n++] = text.slice(pos); break; }
    fields[n++] = text.slice(pos, i);
    pos = i + 1;
  }
  fields.length = n;
  starts.length = n;
  return n;
}

/** A positive decimal integer (1 or more), or -1. Leading zeros are accepted; signs, decimals and exponents are not. */
export function parsePositiveInt(s: string): number {
  const n = s.length;
  if (n === 0 || n > 15) return -1;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return -1;
    v = v * 10 + c;
  }
  return v > 0 ? v : -1;
}

/** Explain why a start or end value is not a coordinate, recognising the usual causes. */
export function coordinateHint(value: string, which: 'start' | 'end'): string {
  if (value === '') return `the ${which} column is empty; every feature needs ${which === 'end' ? 'an end' : 'a start'} coordinate`;
  if (value === '0' || /^0+$/.test(value)) return 'coordinates are 1-based: the first base of a sequence is 1. A 0 usually comes from converting BED (0-based starts) without adding 1';
  if (value === '.') return `\`.\` is not allowed here: every feature needs ${which === 'end' ? 'an end' : 'a start'} coordinate`;
  if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(value)) return `scientific notation is usually a spreadsheet artefact; write the integer, e.g. \`${Number(value).toFixed(0)}\``;
  if (/^\d{1,3}([,_ ]\d{3})+$/.test(value)) return `write it without separators: \`${value.replace(/[,_ ]/g, '')}\``;
  if (/^\d+\.0*$/.test(value)) return `drop the decimal point: \`${value.replace(/\..*$/, '')}\``;
  if (/^-\d+$/.test(value)) return 'coordinates cannot be negative';
  if (/^\+\d+$/.test(value)) return `drop the sign: \`${value.slice(1)}\``;
  if (/^[<>]\d+$/.test(value)) return `partial-feature markers such as \`${value[0]}\` belong to GenBank/GFF2 locations; write the plain integer \`${value.slice(1)}\``;
  if (/^\d+$/.test(value)) return 'the number is too large to be a sequence coordinate';
  if (/^\s|\s$/.test(value)) return 'remove the spaces around the number';
  return `the ${which} column must hold a whole number of bases, counted from 1`;
}

export const RE_SCORE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$|^[-+]?(?:inf|infinity|nan)$/i;

export function scoreHint(score: string): string {
  if (/^[-+]?\d+,\d+$/.test(score)) return `use a decimal point: \`${score.replace(',', '.')}\``;
  if (score === '') return 'write `.` when there is no score';
  if (/^(na|n\/a|null|none|-)$/i.test(score)) return 'write `.` when there is no score';
  if (score === '+' || score === '-') return 'this looks like a strand: a column may be missing before it';
  return 'the score is a number such as `0.95`, `37` or `1e-20`, or `.` when there is none';
}

export function strandHint(strand: string, allowed: string): string {
  if (strand === '1' || strand === '+1') return 'write `+` for the forward strand (numeric strands are an Ensembl/BioMart convention)';
  if (strand === '-1') return 'write `-` for the reverse strand (numeric strands are an Ensembl/BioMart convention)';
  if (strand === '0' || strand === '') return 'write `.` for a feature without a strand';
  if (/^(plus|forward|fwd|f|sense|watson|w)$/i.test(strand)) return 'write `+` for the forward strand';
  if (/^(minus|reverse|rev|r|antisense|crick|c)$/i.test(strand)) return 'write `-` for the reverse strand';
  if (/^[012]$/.test(strand)) return 'this looks like a phase: a column may be missing before it';
  if (/^[-+]?\d*\.\d+$/.test(strand)) return 'this looks like a score: the columns may be shifted';
  return `the strand column must be ${allowed}`;
}

/** Report a line that does not have nine tab-separated columns. Returns the hint used (for tests of wording). */
export function reportColumnCount(ctx: Context, rule: RuleMeta, text: string, n: number, starts: number[], format: string): void {
  const ws = text.trim().split(/\s+/).length;
  let hint: string;
  if (n < 9 && ws >= 9) {
    hint = n === 1
      ? `the fields are separated by spaces; ${format} columns must be separated by single tab characters (a text editor or copy-paste often converts tabs to spaces)`
      : `some fields are separated by spaces instead of tabs; ${format} columns must be separated by single tab characters`;
  } else if (n === 8) hint = 'the attributes column is missing; write `.` in column 9 if a feature has no attributes';
  else if (n < 9 && text.includes(',') && text.split(',').length >= 9) hint = 'the fields are separated by commas; export the table as tab-separated text';
  else if (n < 9) hint = 'the line may be truncated, or a line break inside a value split one record in two';
  else hint = 'a value contains a tab character; inside a value a tab must be written `%09`';
  const col = n < 9 ? text.length : starts[9]! - 1;
  ctx.report(rule, col, text.length + (n < 9 ? 1 : 0), `line has ${plural(n, 'column')}, expected 9`, { hint });
}

// ---------------------------------------------------------------------------------------------- identifier table

const CHUNK_BITS = 14;
const CHUNK = 1 << CHUNK_BITS;
const CHUNK_MASK = CHUNK - 1;

/**
 * A set of identifiers with a few 32-bit numbers attached to each, built for millions of entries.
 *
 * Identifiers are not stored: each is reduced to a 64-bit hash (two independent 32-bit hashes), so one entry costs
 * 8 bytes of hash, 4 bytes per attached column and 5 to 11 bytes of bucket space, instead of the 80-120 bytes a
 * `Map<string, ...>` entry costs in V8. Two different identifiers are confused only if both hashes collide
 * (about 3 in a million for ten million identifiers).
 *
 * Entries are addressed by entry number, which never changes. Their data lives in fixed-size chunks that are
 * allocated as the table fills, so growing never copies or over-allocates entry data; only the bucket array is
 * rebuilt when it doubles.
 */
export class IdTable {
  /** Number of entries. */
  size = 0;
  /** True when the last `intern()` created the entry. */
  added = false;
  private readonly h1: Uint32Array[] = [];
  private readonly h2: Uint32Array[] = [];
  private readonly cols: Uint32Array[][] = [];
  private buckets: Int32Array;   // entry number + 1, 0 = empty
  private mask: number;
  private a = 0;
  private b = 0;

  constructor(columns: number, initialBuckets = 1 << 13) {
    let n = 16;
    while (n < initialBuckets) n <<= 1;
    for (let i = 0; i < columns; i++) this.cols.push([]);
    this.buckets = new Int32Array(n);
    this.mask = n - 1;
  }

  get(column: number, entry: number): number { return this.cols[column]![entry >>> CHUNK_BITS]![entry & CHUNK_MASK]!; }
  set(column: number, entry: number, value: number): void { this.cols[column]![entry >>> CHUNK_BITS]![entry & CHUNK_MASK] = value; }

  private hash(text: string, start: number, end: number): void {
    let a = 0x811c9dc5, b = 0x9747b28c ^ (end - start);
    for (let i = start; i < end; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995);
      b ^= b >>> 15;
    }
    b = Math.imul(b ^ (b >>> 13), 0xc2b2ae35);
    this.a = a >>> 0;
    this.b = (b ^ (b >>> 16)) >>> 0;
  }

  /** Entry number for the current hash, or `-1 - freeBucket` when it is absent. */
  private probe(): number {
    const { buckets, mask, h1, h2, a, b } = this;
    let i = (a ^ Math.imul(b, 0x9e3779b1)) & mask;
    for (;;) {
      const e = buckets[i]! - 1;
      if (e < 0) return -1 - i;
      if (h1[e >>> CHUNK_BITS]![e & CHUNK_MASK] === a && h2[e >>> CHUNK_BITS]![e & CHUNK_MASK] === b) return e;
      i = (i + 1) & mask;
    }
  }

  /** Entry number of `text.slice(start, end)`, or -1. */
  find(text: string, start = 0, end = text.length): number {
    this.hash(text, start, end);
    const r = this.probe();
    return r < 0 ? -1 : r;
  }

  /** Entry number of the identifier, adding it (with all columns 0) if it is new; `added` tells which happened. */
  intern(text: string, start = 0, end = text.length): number {
    this.hash(text, start, end);
    let r = this.probe();
    if (r >= 0) { this.added = false; return r; }
    if ((this.size + 1) * 4 > this.buckets.length * 3) { this.rehash(); r = this.probe(); }
    const e = this.size++;
    const chunk = e >>> CHUNK_BITS;
    if (chunk === this.h1.length) {
      this.h1.push(new Uint32Array(CHUNK));
      this.h2.push(new Uint32Array(CHUNK));
      for (const col of this.cols) col.push(new Uint32Array(CHUNK));
    }
    this.h1[chunk]![e & CHUNK_MASK] = this.a;
    this.h2[chunk]![e & CHUNK_MASK] = this.b;
    this.buckets[-1 - r] = e + 1;
    this.added = true;
    return e;
  }

  private rehash(): void {
    const n = this.buckets.length * 2;
    const buckets = new Int32Array(n);
    const mask = n - 1;
    const { h1, h2 } = this;
    for (let e = 0; e < this.size; e++) {
      let i = (h1[e >>> CHUNK_BITS]![e & CHUNK_MASK]! ^ Math.imul(h2[e >>> CHUNK_BITS]![e & CHUNK_MASK]!, 0x9e3779b1)) & mask;
      while (buckets[i] !== 0) i = (i + 1) & mask;
      buckets[i] = e + 1;
    }
    this.buckets = buckets;
    this.mask = mask;
  }
}

/** Small integers for a limited vocabulary (sequence names, feature types). 0 means "not tracked". */
export class Interner {
  private readonly map = new Map<string, number>();
  readonly names: string[] = [''];
  private readonly limit: number;
  private last = '';
  private lastCode = 0;
  constructor(limit: number) { this.limit = limit; }
  code(s: string): number {
    if (s === this.last) return this.lastCode;
    let c = this.map.get(s);
    if (c === undefined) {
      if (this.names.length > this.limit) c = 0;
      else { c = this.names.length; this.names.push(s); this.map.set(s, c); }
    }
    this.last = s;
    this.lastCode = c;
    return c;
  }
}

// ---------------------------------------------------------------------------------------------- detection

const RE_GTF_ATTR = /^\s*[A-Za-z_][\w.:-]*[ ]+(?:"|[^\s;="]+\s*;)/;
const RE_GFF3_ATTR = /^\s*[^\s;="]+=/;

/** True when column 9 is written the GTF/GFF2 way (`gene_id "X"; ...`). */
export const looksLikeGtfAttributes = (attrs: string): boolean => RE_GTF_ATTR.test(attrs);
/** True when column 9 is written the GFF3 way (`ID=X;...`). */
export const looksLikeGff3Attributes = (attrs: string): boolean => RE_GFF3_ATTR.test(attrs);

export interface Shape {
  /** What a version line at the top says, if anything. */
  pragma: 'gff3' | 'gff2' | 'gtf' | null;
  /** Lines that have the nine-column feature layout. */
  features: number;
  gff3Attrs: number;
  gtfAttrs: number;
}

/** Look at the first lines of a file: the version pragma, and how column 9 of the first feature lines is written. */
export function shapeOf(head: string[]): Shape {
  const shape: Shape = { pragma: null, features: 0, gff3Attrs: 0, gtfAttrs: 0 };
  for (const line of head) {
    if (line === '') continue;
    if (line.charCodeAt(0) === 35) {
      if (shape.pragma === null && shape.features === 0) {
        if (/^##gff-version\s+3/.test(line)) shape.pragma = 'gff3';
        else if (/^##gff-version\s+[12]/.test(line)) shape.pragma = 'gff2';
        else if (/^#+\s*gtf-version/i.test(line) || /^##format:\s*gtf/i.test(line)) shape.pragma = 'gtf';
      }
      if (line.startsWith('##FASTA')) break;
      continue;
    }
    if (line.charCodeAt(0) === 62) break; // '>': FASTA
    const f = line.split('\t');
    if (f.length < 8 || f.length > 10) continue;
    if (!/^\d+$/.test(f[3]!) || !/^\d+$/.test(f[4]!) || !/^[-+.?]$/.test(f[6]!)) continue;
    shape.features++;
    const attrs = f[8] ?? '';
    if (looksLikeGtfAttributes(attrs)) shape.gtfAttrs++;
    else if (looksLikeGff3Attributes(attrs)) shape.gff3Attrs++;
    if (shape.features >= 50) break;
  }
  return shape;
}

export function sniffGff3(head: string[]): number {
  const s = shapeOf(head);
  if (s.features === 0) return s.pragma === 'gff3' ? 0.95 : s.pragma ? 0.05 : 0;
  if (s.gtfAttrs > 0 && s.gtfAttrs >= s.gff3Attrs * 4) return s.pragma === 'gff3' ? 0.5 : 0.05;
  if (s.pragma === 'gff3') return 1;
  if (s.gff3Attrs >= s.features * 0.8) return 0.9;
  return s.pragma ? 0.2 : 0.4;
}

export function sniffGtf(head: string[]): number {
  const s = shapeOf(head);
  if (s.features === 0) return s.pragma === 'gtf' ? 0.9 : 0;
  if (s.gff3Attrs > 0 && s.gff3Attrs >= s.gtfAttrs * 4) return 0.05;
  if (s.gtfAttrs >= s.features * 0.8) return s.pragma === 'gff3' ? 0.6 : 0.95;
  if (s.pragma === 'gff3') return 0.05;
  return s.pragma === 'gtf' ? 0.6 : 0.35;
}

/** Quote a value for a message. */
export const q = (s: string, max?: number): string => '`' + show(s, max) + '`';
