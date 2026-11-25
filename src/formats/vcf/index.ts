import type { Context, FormatDef, Line, Validator } from '../../core/types.ts';
import { oneOf, plural, show, splitWithOffsets, suggest } from '../../core/util.ts';
import { V } from './rules.ts';

interface FieldDef { number: string; type: string; line: number }
interface MetaField { key: string; value: string; quoted: boolean; keyCol: number; valCol: number; valEnd: number }
interface FormatSpec { keys: string[]; defs: (FieldDef | undefined)[]; starts: number[]; gtIndex: number }

const VERSIONS: Record<string, number> = { 'VCFv4.0': 40, 'VCFv4.1': 41, 'VCFv4.2': 42, 'VCFv4.3': 43, 'VCFv4.4': 44, 'VCFv4.5': 45 };
const FIXED = ['#CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO'];
const STANDARD_META_KEYS = ['fileformat', 'INFO', 'FORMAT', 'FILTER', 'ALT', 'contig', 'SAMPLE', 'PEDIGREE', 'META', 'assembly', 'pedigreeDB'];
const INFO_TYPES = ['Integer', 'Float', 'Flag', 'Character', 'String'];
const FORMAT_TYPES = ['Integer', 'Float', 'Character', 'String'];

/** Reserved keys as described in prose by VCF 4.1/4.2 (no AD/ADF/ADR, GLE still present). */
const RESERVED_INFO_OLD: Record<string, [string, string]> = {
  AA: ['1', 'String'], AC: ['A', 'Integer'], AF: ['A', 'Float'], AN: ['1', 'Integer'], BQ: ['1', 'Float'], CIGAR: ['A', 'String'], DB: ['0', 'Flag'],
  DP: ['1', 'Integer'], END: ['1', 'Integer'], H2: ['0', 'Flag'], H3: ['0', 'Flag'], MQ: ['1', 'Float'], MQ0: ['1', 'Integer'], NS: ['1', 'Integer'],
  SOMATIC: ['0', 'Flag'], VALIDATED: ['0', 'Flag'], '1000G': ['0', 'Flag'],
};
const RESERVED_FORMAT_OLD: Record<string, [string, string]> = {
  DP: ['1', 'Integer'], EC: ['A', 'Integer'], FT: ['1', 'String'], GL: ['G', 'Float'], GLE: ['G', 'String'], GP: ['G', 'Float'], GQ: ['1', 'Integer'],
  GT: ['1', 'String'], HQ: ['2', 'Integer'], MQ: ['1', 'Integer'], PL: ['G', 'Integer'], PQ: ['1', 'Integer'], PS: ['1', 'Integer'],
};
const RESERVED_INFO: Record<string, [string, string]> = {
  AA: ['1', 'String'], AC: ['A', 'Integer'], AD: ['R', 'Integer'], ADF: ['R', 'Integer'], ADR: ['R', 'Integer'], AF: ['A', 'Float'], AN: ['1', 'Integer'],
  BQ: ['1', 'Float'], CIGAR: ['A', 'String'], DB: ['0', 'Flag'], DP: ['1', 'Integer'], END: ['1', 'Integer'], H2: ['0', 'Flag'], H3: ['0', 'Flag'],
  MQ: ['1', 'Float'], MQ0: ['1', 'Integer'], NS: ['1', 'Integer'], SB: ['4', 'Integer'], SOMATIC: ['0', 'Flag'], VALIDATED: ['0', 'Flag'], '1000G': ['0', 'Flag'],
};
const RESERVED_FORMAT: Record<string, [string, string]> = {
  AD: ['R', 'Integer'], ADF: ['R', 'Integer'], ADR: ['R', 'Integer'], DP: ['1', 'Integer'], EC: ['A', 'Integer'], FT: ['1', 'String'], GL: ['G', 'Float'],
  GP: ['G', 'Float'], GQ: ['1', 'Integer'], GT: ['1', 'String'], HQ: ['2', 'Integer'], MQ: ['1', 'Integer'], PL: ['G', 'Integer'], PP: ['G', 'Integer'],
  PQ: ['1', 'Integer'], PS: ['1', 'Integer'],
};

const RE_KEY = /^[A-Za-z_][0-9A-Za-z_.]*$/;
const RE_BASES = /^[ACGTNacgtn]+$/;
const RE_IUPAC = /^[ACGTNRYSWKMBDHVacgtnryswkmbdhv]+$/;
const RE_INT = /^[-+]?\d+$/;
const RE_FLOAT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$|^[-+]?(?:inf|infinity|nan)$/i;
const RE_UINT = /^\d+$/;
const RE_BREAKEND = /^(?:(?:[ACGTNacgtn]+|\.)[[\]][^[\]\s]+:\d+[[\]]|[[\]][^[\]\s]+:\d+[[\]](?:[ACGTNacgtn]+|\.))$/;
const RE_BREAKEND_BARE = /^[[\]][^[\]\s]+:\d+[[\]]$/;
const RE_CONTIG = /^[0-9A-Za-z!#$%&+./:;?@^_|~-][0-9A-Za-z!#$%&*+./:;=?@^_|~-]*$/;
const RE_CIGAR = /^(?:\d+[MIDNSHPX=])+$/;
const ALT_TYPES = ['DEL', 'INS', 'DUP', 'INV', 'CNV'];
const NON_NEGATIVE_INFO = new Set(['AC', 'AN', 'DP', 'END', 'MQ0', 'NS']);
const RE_SINGLE_BREAKEND = /^(?:\.[ACGTNacgtn]+|[ACGTNacgtn]+\.)$/;
const RE_GT = /^(?:\.|\d+)(?:[/|](?:\.|\d+))*$/;
const RE_GT_PREFIX = /^[/|]?(?:\.|\d+)(?:[/|](?:\.|\d+))*$/;
const INT_MIN_OK = -2147483640;
const INT_MAX = 2147483647;

/** Parse the inside of `<...>`; `start` is the index just after `<`. */
function parseStructured(text: string, start: number): { fields: MetaField[]; error?: { col: number; end: number; message: string; hint?: string } } {
  const fields: MetaField[] = [];
  const n = text.length;
  if (text[n - 1] !== '>') {
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed.endsWith('>')) return { fields, error: { col: trimmed.length, end: n, message: 'whitespace after the closing `>`', hint: 'remove the trailing whitespace' } };
    return { fields, error: { col: Math.max(start - 1, n - 1), end: n, message: 'structured line does not end with `>`', hint: 'close the line with `>`; if a Description contains `"`, escape it as `\\"`' } };
  }
  const end = n - 1;
  let i = start;
  if (i === end) return { fields, error: { col: start - 1, end: n, message: 'structured line is empty (`<>`)' } };
  while (i < end) {
    const keyCol = i;
    while (i < end && text[i] !== '=' && text[i] !== ',') i++;
    const key = text.slice(keyCol, i);
    if (i >= end || text[i] === ',') {
      const prev = fields[fields.length - 1];
      const thousands = /^\d{3}$/.test(key) && prev && /^\d+$/.test(prev.value) && !prev.quoted;
      return { fields, error: { col: keyCol, end: Math.max(i, keyCol + 1), message: key ? `entry \`${show(key)}\` has no \`=value\`` : 'empty entry between commas',
        hint: thousands ? `commas separate entries here, so numbers cannot use thousands separators: write \`${prev!.key}=${prev!.value}${key}…\` without commas` : 'entries are `key=value`, separated by commas; a value containing a comma must be quoted' } };
    }
    if (!key) return { fields, error: { col: keyCol, end: keyCol + 1, message: 'entry has no key before `=`' } };
    i++; // skip '='
    const valCol = i;
    let value: string;
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      let j = i + 1;
      while (j < end && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= end) {
        return { fields, error: { col: i, end: i + 1, message: `quoted value of \`${show(key)}\` is never closed`, hint: 'add the closing `"` before `>`; a `"` inside the text must be written `\\"`' } };
      }
      value = text.slice(i + 1, j);
      i = j + 1;
      if (i < end && text[i] !== ',') {
        return { fields, error: { col: i, end: Math.min(end, i + 12), message: `unexpected text after the closing quote of \`${show(key)}\``, hint: 'a `"` inside a quoted value must be escaped as `\\"`' } };
      }
    } else if (text[i] === '[') {
      let j = text.indexOf(']', i);
      if (j < 0 || j >= end) j = end - 1;
      value = text.slice(i, j + 1);
      i = j + 1;
    } else {
      while (i < end && text[i] !== ',') i++;
      value = text.slice(valCol, i);
    }
    fields.push({ key, value, quoted, keyCol, valCol, valEnd: i });
    if (i < end) i++; // skip ','
    if (i === end && text[end - 1] === ',') return { fields, error: { col: end - 1, end, message: 'trailing comma before `>`' } };
  }
  return { fields };
}

function genotypeCount(ploidy: number, alleles: number): number {
  // C(alleles + ploidy - 1, ploidy)
  let r = 1;
  for (let k = 1; k <= ploidy; k++) r = (r * (alleles - 1 + k)) / k;
  return Math.round(r);
}

class VcfValidator implements Validator {
  private version = 42;
  private versionName = 'VCF 4.2';
  private headerSeen = false;
  private headerLine = 0;
  private nCols = 8;
  private samples = 0;
  private records = 0;
  private reportedHeaderMissing = false;

  private readonly info = new Map<string, FieldDef>();
  private readonly format = new Map<string, FieldDef>();
  private readonly filters = new Map<string, number>();
  private readonly alts = new Map<string, number>();
  private readonly contigs = new Map<string, number>();   // id -> length (or -1)
  private readonly otherIds = new Map<string, Map<string, number>>();

  private readonly warned = { info: new Set<string>(), format: new Set<string>(), filter: new Set<string>(), alt: new Set<string>(), contig: new Set<string>(), notContiguous: new Set<string>() };
  private readonly seenChroms = new Set<string>();
  private chrom = '';
  private pos = -1;
  private samePos = new Set<string>();
  private readonly formatCache = new Map<string, FormatSpec>();
  private readonly impliedDefs = new Map<string, FieldDef>();

  private reserved(kind: 'INFO' | 'FORMAT', key: string): [string, string] | undefined {
    const table = kind === 'INFO' ? (this.version >= 43 ? RESERVED_INFO : RESERVED_INFO_OLD) : (this.version >= 43 ? RESERVED_FORMAT : RESERVED_FORMAT_OLD);
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  }

  /** Definition to check values against: the header's, or the specification's for an undeclared reserved key. */
  private defOf(kind: 'INFO' | 'FORMAT', key: string): FieldDef | undefined {
    const declared = (kind === 'INFO' ? this.info : this.format).get(key);
    if (declared) return declared;
    const k = kind + ':' + key;
    let implied = this.impliedDefs.get(k);
    if (!implied) {
      const r = this.reserved(kind, key);
      if (!r) return undefined;
      implied = { number: r[0], type: r[1], line: 0 };
      this.impliedDefs.set(k, implied);
    }
    return implied;
  }

  // ------------------------------------------------------------------ dispatch

  line(l: Line, ctx: Context): void {
    const text = l.text;
    if (l.no === 1) {
      this.fileformat(text, ctx);
      if (text.startsWith('##')) return;
    }
    if (text.startsWith('##')) {
      if (l.no > 1 && text.startsWith('##fileformat=')) {
        ctx.report(V.fileformatRepeated, 0, text.length, '`##fileformat` appears again; it belongs on the first line only', {
          hint: 'if two VCF files were joined with `cat`, use `bcftools concat` or `bcftools merge` instead',
          notes: this.headerSeen ? [`the column header is on line ${this.headerLine}`] : [],
        });
        return;
      }
      if (this.headerSeen) {
        ctx.report(V.metaAfterHeader, 0, Math.min(text.length, 2), 'meta-information line after the `#CHROM` header line', {
          hint: 'move all `##` lines above the `#CHROM` line; to join files use `bcftools concat`, not `cat`',
          notes: [`the column header is on line ${this.headerLine}`],
        });
        return;
      }
      this.meta(text, l.no, ctx);
      return;
    }
    if (text.startsWith('#')) {
      if (this.headerSeen && !/^#CHROM(\t| |$)/.test(text)) {
        ctx.report(V.commentInBody, 0, Math.min(text.length, 24), 'line starting with `#` among the records', {
          hint: 'VCF has no comment syntax after the header: remove the line, or move the information into a `##` meta line above `#CHROM`',
          notes: /^#FGQB\b/.test(text) ? ['`#FGQB` lines are a vendor extension found in some gVCF files; they are not part of VCF'] : [],
        });
        return;
      }
      if (this.headerSeen) {
        ctx.report(V.headerRepeated, 0, text.length, 'a second column header line', {
          hint: 'the file looks like several VCFs joined with `cat`; use `bcftools concat` (same samples) or `bcftools merge`',
          notes: [`the first column header is on line ${this.headerLine}`],
        });
        return;
      }
      this.header(text, l.no, ctx);
      return;
    }
    this.record(text, l, ctx);
  }

  end(ctx: Context): void {
    if (!this.headerSeen && !this.reportedHeaderMissing) {
      ctx.reportAt(V.headerMissing, 0, 'the file has no `#CHROM` column header line', {
        hint: 'add a tab-separated line `#CHROM POS ID REF ALT QUAL FILTER INFO` after the `##` lines',
      });
    } else if (this.headerSeen && this.records === 0) {
      ctx.reportAt(V.noRecords, 0, 'the file has a header but no variant records', { hint: 'fine if no variants are expected here; otherwise check the step that produced the file' });
    }
    ctx.stat('version', this.versionName);
    ctx.stat('records', this.records);
    ctx.stat('samples', this.samples);
  }

  // ------------------------------------------------------------------ meta lines

  private fileformat(text: string, ctx: Context): void {
    if (!text.startsWith('##fileformat=')) {
      const m = /^##\s*file\s*format\s*=/i.exec(text);
      ctx.report(V.fileformatMissing, 0, Math.min(text.length, 40), m ? 'the first line must be spelled exactly `##fileformat=VCFv4.x`' : 'the first line must be `##fileformat=VCFv4.x`', {
        hint: 'insert `##fileformat=VCFv4.2` (or the version the file follows) as the very first line',
        notes: ['checking the rest of the file as VCF 4.2'],
      });
      return;
    }
    const value = text.slice(13);
    const v = VERSIONS[value];
    if (v === undefined) {
      const guess = suggest(value.trim(), Object.keys(VERSIONS)) ?? (/4\.[0-5]/.exec(value) ? 'VCFv' + /4\.[0-5]/.exec(value)![0] : undefined);
      ctx.report(V.fileformatInvalid, 13, text.length, `\`${show(value)}\` is not a VCF version this tool knows`, {
        hint: guess ? `did you mean \`##fileformat=${guess}\`?` : `use one of ${oneOf(Object.keys(VERSIONS).slice(1))}`,
        notes: ['checking the rest of the file as VCF 4.2'],
      });
      const g = guess ? VERSIONS[guess] : undefined;
      if (g) { this.version = g; this.versionName = 'VCF ' + guess!.slice(4); }
      return;
    }
    this.version = v;
    this.versionName = 'VCF ' + value.slice(4);
  }

  private meta(text: string, lineNo: number, ctx: Context): void {
    const eq = text.indexOf('=');
    if (eq < 0 || eq === 2) {
      ctx.report(V.metaMalformed, 0, text.length, eq < 0 ? 'meta-information line has no `=`' : 'meta-information line has no key before `=`', { hint: 'the form is `##key=value`' });
      return;
    }
    const key = text.slice(2, eq);
    if (eq === text.length - 1) {
      ctx.report(V.metaMalformed, eq, eq + 1, `\`##${show(key)}=\` has an empty value`, { hint: 'give it a value or delete the line' });
      return;
    }
    const canonical = STANDARD_META_KEYS.find((k) => k !== key && k.toLowerCase() === key.toLowerCase());
    if (canonical) {
      ctx.report(V.metaKeyCase, 2, eq, `\`##${show(key)}\` is not the standard key \`##${canonical}\`: meta keys are case-sensitive`, { hint: `write \`##${canonical}=\`` });
    }
    if (text[eq + 1] !== '<') return; // unstructured line: nothing more to check
    // `##pedigreeDB=<url>` and `##assembly=url` hold a URL, not key=value entries.
    if (key === 'pedigreeDB' || key === 'assembly') {
      if (text.length === eq + 3 && text[eq + 2] === '>') ctx.report(V.metaMalformed, eq + 1, text.length, `\`##${key}\` has an empty URL`, { hint: 'give the URL, or delete the line' });
      else if (text[text.length - 1] !== '>') ctx.report(V.metaStructure, eq + 1, text.length, `\`##${key}=<\` is never closed with \`>\``);
      return;
    }

    const parsed = parseStructured(text, eq + 2);
    const kind = canonical ?? key;
    const known = kind === 'INFO' || kind === 'FORMAT' || kind === 'FILTER' || kind === 'ALT' || kind === 'contig';
    // Before 4.3 a `<` did not make a custom line structured, so only the defined kinds are held to the syntax.
    if (parsed.error && !known && this.version < 43) return;
    if (parsed.error) {
      const e = parsed.error;
      ctx.report(V.metaStructure, e.col, e.end, e.message, e.hint ? { hint: e.hint } : undefined);
      // Keep going with what was parsed so later records do not also report "undeclared".
    }
    const f = parsed.fields;
    const get = (k: string) => f.find((x) => x.key === k);
    const id = get('ID');

    if (!id) {
      if (!parsed.error && (known || this.version >= 43)) {
        const wrongCase = f.find((x) => x.key.toLowerCase() === 'id');
        ctx.report(V.metaIdMissing, eq + 1, text.length, `\`##${show(key)}\` line has no \`ID\``, { hint: wrongCase ? `\`${wrongCase.key}\` must be written \`ID\`` : 'add `ID=<name>` as the first entry' });
      }
      return;
    }
    if (!id.value) {
      ctx.report(V.metaIdMissing, id.keyCol, id.valEnd, 'ID is empty');
      return;
    }

    // Duplicate IDs within a kind.
    const table: Map<string, unknown> | undefined =
      kind === 'INFO' ? this.info : kind === 'FORMAT' ? this.format : kind === 'FILTER' ? this.filters : kind === 'ALT' ? this.alts : kind === 'contig' ? this.contigs : undefined;
    let firstLine = 0;
    if (table) {
      if (table.has(id.value)) {
        const prev = table.get(id.value);
        firstLine = typeof prev === 'number' ? (kind === 'contig' ? 0 : prev) : (prev as FieldDef).line;
        ctx.report(V.metaIdDuplicate, id.valCol, id.valEnd, `\`##${kind}\` ID \`${show(id.value)}\` is already defined`, {
          hint: 'keep one definition and delete the other',
          notes: firstLine ? [`first defined on line ${firstLine}`] : [],
        });
        return;
      }
    } else if (this.version >= 43) {
      let ids = this.otherIds.get(kind);
      if (!ids) this.otherIds.set(kind, (ids = new Map()));
      const prev = ids.get(id.value);
      if (prev !== undefined) {
        ctx.report(V.metaIdDuplicate, id.valCol, id.valEnd, `\`##${show(kind)}\` ID \`${show(id.value)}\` is already defined`, { notes: [`first defined on line ${prev}`] });
      } else ids.set(id.value, lineNo);
    }

    const partial = !!parsed.error;
    if (kind === 'INFO' || kind === 'FORMAT') this.metaInfoFormat(kind, f, id, text, eq, lineNo, partial, ctx);
    else if (kind === 'FILTER') {
      this.filters.set(id.value, lineNo);
      if (id.value === '0' || /[\s;]/.test(id.value)) {
        ctx.report(V.metaIdInvalid, id.valCol, id.valEnd, id.value === '0' ? 'FILTER ID `0` is reserved' : `FILTER ID \`${show(id.value)}\` contains whitespace or a semicolon`, { hint: 'use a short name without spaces, e.g. `LowQual`' });
      }
      if (!partial) this.requireDescription(kind, f, text, eq, ctx, this.version >= 44);
    } else if (kind === 'ALT') {
      this.alts.set(id.value, lineNo);
      if (/[\s,<>]/.test(id.value)) ctx.report(V.metaIdInvalid, id.valCol, id.valEnd, `ALT ID \`${show(id.value)}\` contains whitespace, a comma or an angle bracket`);
      else if (this.version < 43 || id.value.includes(':')) {
        const top = id.value.split(':')[0]!;
        const ok = ALT_TYPES.includes(top) || (top === 'BND' && this.version < 44) || top === '*' || top === 'NON_REF' || /^[RYSWKMBDHVN]$/.test(id.value);
        if (!ok) {
          const near = suggest(top, ALT_TYPES) ?? ALT_TYPES.find((t) => top.toUpperCase().startsWith(t));
          ctx.report(V.altTypeUnknown, id.valCol, id.valCol + top.length, `ALT type \`${show(top)}\` is not one of the structural variant types the specification defines`, {
            hint: near ? `did you mean \`${near}\`? a subtype goes after a colon, e.g. \`${near === 'DUP' ? 'DUP:TANDEM' : near === 'CNV' ? 'CNV:TR' : near + ':ME'}\`` : `the first-level type must be ${oneOf(ALT_TYPES)}; put your own subtype after a colon, e.g. \`DEL:ME\``,
          });
        }
      }
      if (!partial) this.requireDescription(kind, f, text, eq, ctx, this.version >= 44);
    } else if (kind === 'contig') {
      let length = -1;
      const len = get('length');
      if (len) {
        if (RE_UINT.test(len.value) && Number(len.value) > 0) length = Number(len.value);
        else {
          const digits = len.value.replace(/[,_ .]/g, '');
          ctx.report(V.contigLengthInvalid, len.valCol, len.valEnd, `contig length \`${show(len.value)}\` is not a positive integer`, {
            hint: RE_UINT.test(digits) && digits !== len.value ? `write it without separators: \`length=${digits}\`` : 'use the sequence length in bases, digits only',
          });
        }
      }
      this.contigs.set(id.value, length);
      if (/[\s,<>]/.test(id.value)) ctx.report(V.metaIdInvalid, id.valCol, id.valEnd, `contig name \`${show(id.value)}\` contains whitespace, a comma or an angle bracket`);
    }
  }

  private requireDescription(kind: string, f: MetaField[], text: string, eq: number, ctx: Context, optional = false): void {
    const d = f.find((x) => x.key === 'Description');
    if (!d) {
      if (optional) return;
      const near = f.find((x) => x.key.toLowerCase() === 'description' || x.key.toLowerCase() === 'desc');
      if (near) ctx.report(V.metaFieldMissing, near.keyCol, near.keyCol + near.key.length, `\`${show(near.key)}\` must be spelled \`Description\``);
      else ctx.report(V.metaFieldMissing, eq + 1, text.length, `\`##${kind}\` line has no \`Description\``, { hint: 'add `Description="..."`' });
    } else if (!d.quoted) {
      ctx.report(V.metaDescriptionUnquoted, d.valCol, d.valEnd, 'Description must be in double quotes', { hint: `write \`Description="${show(d.value, 30)}"\`` });
    }
  }

  private metaInfoFormat(kind: 'INFO' | 'FORMAT', f: MetaField[], id: MetaField, text: string, eq: number, lineNo: number, partial: boolean, ctx: Context): void {
    const get = (k: string) => f.find((x) => x.key === k);
    const number = get('Number');
    const type = get('Type');
    const def: FieldDef = { number: number?.value ?? '.', type: type?.value ?? 'String', line: lineNo };
    (kind === 'INFO' ? this.info : this.format).set(id.value, def);

    const idOk = id.value === '1000G' && kind === 'INFO' ? true : RE_KEY.test(id.value);
    if (!idOk && (this.version >= 43 || /[\s;=:,]/.test(id.value))) {
      ctx.report(V.metaIdInvalid, id.valCol, id.valEnd, `${kind} ID \`${show(id.value)}\` must match \`[A-Za-z_][0-9A-Za-z_.]*\``, {
        hint: `rename it, e.g. \`${id.value.replace(/[^0-9A-Za-z_.]/g, '_').replace(/^[^A-Za-z_]/, '_$&')}\`, in the header and in every record`,
      });
    }
    for (const required of ['Number', 'Type']) {
      if (!get(required) && !partial) {
        const near = f.find((x) => x.key.toLowerCase() === required.toLowerCase());
        if (near) ctx.report(V.metaFieldMissing, near.keyCol, near.keyCol + near.key.length, `\`${show(near.key)}\` must be spelled \`${required}\``);
        else ctx.report(V.metaFieldMissing, eq + 1, text.length, `\`##${kind}\` line has no \`${required}\``, { hint: `add \`${required}=...\` after the ID` });
      }
    }
    if (!partial) this.requireDescription(kind, f, text, eq, ctx);

    let numberOk = true;
    if (number) {
      const nv = number.value;
      const allowed = RE_UINT.test(nv) || nv === 'A' || nv === 'G' || nv === '.' || nv === 'R' ||
        (kind === 'FORMAT' && ((nv === 'P' && this.version >= 44) || (this.version >= 45 && (nv === 'LA' || nv === 'LR' || nv === 'LG' || nv === 'M'))));
      if (!allowed) {
        numberOk = false;
        const later = nv === 'P' || nv === 'LA' || nv === 'LR' || nv === 'LG' || nv === 'M';
        ctx.report(V.metaNumberInvalid, number.valCol, number.valEnd,
          later ? `\`Number=${nv}\` is only defined for FORMAT lines in VCF ${nv === 'P' ? '4.4' : '4.5'} and later` : `\`Number=${show(nv)}\` is not a valid Number`, {
            hint: nv === '-1' ? 'use `Number=.` for "varies"' : nv.toLowerCase() === 'a' || nv.toLowerCase() === 'g' || nv.toLowerCase() === 'r' ? `use upper case: \`Number=${nv.toUpperCase()}\`` : 'use a non-negative integer, `A`, `R`, `G` or `.`',
          });
      } else if (nv === 'R' && this.version < 42) {
        ctx.report(V.metaNumberVersion, number.valCol, number.valEnd, `\`Number=R\` was introduced in VCF 4.2 but this file declares ${this.versionName}`, { hint: 'change the first line to `##fileformat=VCFv4.2`' });
      }
    }
    if (type) {
      const types = kind === 'INFO' ? INFO_TYPES : FORMAT_TYPES;
      if (!types.includes(type.value)) {
        const guess = suggest(type.value, types) ?? (/^int/i.test(type.value) ? 'Integer' : /^(double|real|num)/i.test(type.value) ? 'Float' : /^(str|text)/i.test(type.value) ? 'String' : /^(bool)/i.test(type.value) ? 'Flag' : /^char/i.test(type.value) ? 'Character' : undefined);
        ctx.report(V.metaTypeInvalid, type.valCol, type.valEnd,
          type.value === 'Flag' ? 'Type=Flag is only allowed for INFO, not FORMAT' : `Type=${show(type.value)} is not a valid ${kind} type`, {
            hint: guess && types.includes(guess) ? `did you mean \`Type=${guess}\`?` : `use one of ${oneOf(types)}`,
          });
        def.type = 'String';
      } else if (number && numberOk) {
        if (type.value === 'Flag' && number.value !== '0') {
          ctx.report(V.metaFlagNumber, number.valCol, number.valEnd, `a Flag takes no value, so its Number must be 0, not ${show(number.value)}`, { hint: 'write `Number=0`' });
        } else if (type.value !== 'Flag' && number.value === '0') {
          ctx.report(V.metaFlagNumber, number.valCol, number.valEnd, `Number=0 means "no value", which only makes sense for Type=Flag, not ${type.value}`, { hint: kind === 'INFO' ? 'use `Type=Flag`, or a Number of 1 or more' : 'use a Number of 1 or more' });
        }
      }
    }
    if (number && type && numberOk && (this.version >= 43 || ctx.profile === 'strict')) {
      const reserved = this.reserved(kind, id.value);
      if (reserved && (reserved[0] !== number.value || reserved[1] !== type.value) && INFO_TYPES.includes(type.value)) {
        const wrongNumber = reserved[0] !== number.value;
        const at = wrongNumber ? number : type;
        ctx.report(V.metaReservedMismatch, at.valCol, at.valEnd,
          `\`${id.value}\` is a reserved ${kind} key defined as Number=${reserved[0]}, Type=${reserved[1]}, but is declared Number=${show(number.value)}, Type=${show(type.value)}`, {
            hint: `declare it as \`Number=${reserved[0]},Type=${reserved[1]}\`, or use a different key name for this annotation`,
          });
      }
    }
    if (this.version >= 43 && ctx.enabled(V.metaOptionalUnquoted)) {
      for (const x of f) {
        if (x.key === 'ID' || x.key === 'Number' || x.key === 'Type' || x.key === 'Description' || x.key === 'IDX' || x.quoted) continue;
        ctx.report(V.metaOptionalUnquoted, x.valCol, x.valEnd, `value of optional field \`${show(x.key)}\` must be a quoted string`, { hint: `write \`${x.key}="${show(x.value, 30)}"\`` });
      }
    }
  }

  // ------------------------------------------------------------------ header line

  private header(text: string, lineNo: number, ctx: Context): void {
    this.headerSeen = true;
    this.headerLine = lineNo;
    let { fields, starts } = splitWithOffsets(text, '\t');
    if (fields.length < 8 && /^#CHROM[ ]+POS/.test(text)) {
      ctx.report(V.headerColumns, 0, text.length, 'the column header is separated by spaces, not tabs', {
        hint: 'replace the runs of spaces with single tab characters (and do the same in the records if needed)',
      });
      const parts = text.split(/[ \t]+/);
      this.nCols = Math.max(8, parts.length);
      this.samples = Math.max(0, parts.length - 9);
      return;
    }
    let bad = false;
    for (let i = 0; i < 8; i++) {
      if (fields[i] !== FIXED[i]) {
        bad = true;
        const got = fields[i];
        const col = starts[i] ?? text.length;
        if (got === undefined) {
          ctx.report(V.headerColumns, text.length, text.length + 1, `the column header ends before \`${FIXED[i]}\``, { hint: 'the eight fixed columns are `#CHROM POS ID REF ALT QUAL FILTER INFO`, tab-separated' });
        } else {
          ctx.report(V.headerColumns, col, col + Math.max(1, got.length), `column ${i + 1} must be \`${FIXED[i]}\`, found \`${show(got)}\``, {
            hint: got.trim() === FIXED[i] ? 'remove the surrounding spaces' : got.toUpperCase() === FIXED[i] ? `column names are upper case: \`${FIXED[i]}\`` : 'the eight fixed columns are `#CHROM POS ID REF ALT QUAL FILTER INFO`, in this order',
          });
        }
        break;
      }
    }
    this.nCols = Math.max(8, fields.length);
    if (bad) return;
    if (fields.length === 9) {
      ctx.report(V.headerFormatSamples, starts[8]!, text.length, fields[8] === 'FORMAT' ? 'the header has a FORMAT column but no sample columns' : `a ninth column \`${show(fields[8]!)}\` without \`FORMAT\` before it`, {
        hint: fields[8] === 'FORMAT' ? 'add the sample names after FORMAT, or remove the FORMAT column from header and records' : 'genotype columns must be introduced by a `FORMAT` column',
      });
    } else if (fields.length > 9 && fields[8] !== 'FORMAT') {
      ctx.report(V.headerFormatSamples, starts[8]!, starts[8]! + Math.max(1, fields[8]!.length), `the ninth column must be \`FORMAT\`, found \`${show(fields[8]!)}\``, { hint: 'insert a `FORMAT` column between `INFO` and the first sample' });
    }
    this.samples = Math.max(0, fields.length - 9);
    const seen = new Map<string, number>();
    for (let i = 9; i < fields.length; i++) {
      const name = fields[i]!;
      if (name === '') {
        ctx.report(V.headerColumns, starts[i]!, starts[i]! + 1, i === fields.length - 1 ? 'the header line ends with a tab (empty last sample name)' : 'empty sample name', { hint: 'remove the extra tab' });
        continue;
      }
      const first = seen.get(name);
      if (first !== undefined) {
        ctx.report(V.headerDuplicateSample, starts[i]!, starts[i]! + name.length, `sample name \`${show(name)}\` appears twice (columns ${first + 1} and ${i + 1})`, { hint: 'give every sample a unique name, e.g. with `bcftools reheader -s`' });
      } else seen.set(name, i);
    }
  }

  // ------------------------------------------------------------------ records

  private record(text: string, l: Line, ctx: Context): void {
    if (!this.headerSeen && !this.reportedHeaderMissing) {
      this.reportedHeaderMissing = true;
      ctx.report(V.headerMissing, 0, Math.min(text.length, 20), 'a record appears before any `#CHROM` column header line', {
        hint: 'add a tab-separated line `#CHROM POS ID REF ALT QUAL FILTER INFO` (plus `FORMAT` and sample names) above the first record',
      });
      this.nCols = Math.max(8, text.split('\t').length);
    }
    this.records++;
    const { fields, starts } = splitWithOffsets(text, '\t');
    const n = fields.length;
    if (n !== this.nCols) {
      const expected = this.nCols;
      if (text.trim() === '') {
        ctx.report(V.columnCount, 0, text.length, 'blank line inside the records', { hint: 'delete the empty line' });
        this.records--;
        return;
      }
      const ws = text.trim().split(/\s+/).length;
      let hint: string;
      if (n < expected && ws > n && (ws >= expected || (n < 8 && ws >= 8))) hint = 'the fields seem to be separated by spaces; VCF columns must be separated by single tab characters';
      else if (n > expected && fields[n - 1] === '') hint = 'the line ends with an extra tab; remove it';
      else if (n < expected && n >= 8) hint = `the header names ${plural(this.samples, 'sample')} but this record has ${plural(Math.max(0, n - 9), 'sample column')}`;
      else if (n < expected) hint = 'the line may be truncated, or a tab was replaced by spaces';
      else hint = 'a value may contain a tab, or the header is missing a column';
      ctx.report(V.columnCount, n < expected ? text.length : starts[expected]! - 1, text.length + (n < expected ? 1 : 0), `record has ${plural(n, 'column')} but ${this.headerSeen ? 'the header has' : 'at least'} ${expected}`, { hint });
      if (n < 8) return;
    }
    const limit = Math.min(n, this.nCols);
    let hasEmpty = false;
    for (let i = 0; i < limit; i++) {
      if (fields[i] === '') {
        hasEmpty = true;
        ctx.report(V.emptyField, starts[i]!, starts[i]! + 1, `${i < 9 ? (i === 8 ? 'FORMAT' : FIXED[i]!.replace('#', '')) : 'sample'} field is empty`, { hint: 'write `.` for a missing value' });
        if (i >= 9) break;
      }
    }

    // CHROM
    const chrom = fields[0]!;
    if (chrom !== '') {
      if (/\s/.test(chrom)) {
        ctx.report(V.chromInvalid, starts[0]!, starts[0]! + chrom.length, `CHROM \`${show(chrom)}\` contains whitespace`, { hint: 'contig names cannot contain spaces; check that the columns are separated by tabs' });
      } else if (chrom.startsWith('<') ? !/^<[^<>\s]+>$/.test(chrom) : /[<>]/.test(chrom)) {
        ctx.report(V.chromInvalid, starts[0]!, starts[0]! + chrom.length, `CHROM \`${show(chrom)}\` is not a valid contig name`, {
          hint: 'angle brackets are only allowed as a complete `<ID>` reference to an assembly contig',
        });
      }
    }
    if (chrom !== '' && !chrom.startsWith('<') && !/[\s<>]/.test(chrom) && this.chrom !== chrom && ctx.enabled(V.chromCharacters)) {
      const bad = !RE_CONTIG.test(chrom);
      if (bad && !this.warned.contig.has('chars:' + chrom)) {
        this.warned.contig.add('chars:' + chrom);
        const m = /[^0-9A-Za-z!#$%&*+./:;=?@^_|~-]/.exec(chrom)?.[0] ?? chrom[0]!;
        const at = chrom.indexOf(m);
        ctx.report(V.chromCharacters, starts[0]! + at, starts[0]! + at + 1, `contig name \`${show(chrom)}\` ${at === 0 && /[*=]/.test(m) ? 'starts with' : 'contains'} \`${show(m)}\`, which is not allowed in contig names`, {
          hint: 'contig names follow the SAM rules: printable ASCII except \\ , " ` \' ( ) [ ] { } < >, and not starting with `*` or `=`',
        });
      }
    }
    // POS
    let pos = -1;
    const posText = fields[1]!;
    if (posText !== '') {
      if (RE_UINT.test(posText) && Number(posText) <= INT_MAX) pos = Number(posText);
      else {
        let hint = 'POS is a whole number of bases, 1-based';
        if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(posText)) hint = `scientific notation is usually a spreadsheet artefact; write the integer, e.g. \`${Number(posText).toFixed(0)}\``;
        else if (/^\d{1,3}([,_ ]\d{3})+$/.test(posText)) hint = `write it without separators: \`${posText.replace(/[,_ ]/g, '')}\``;
        else if (/^\d+\.0*$/.test(posText)) hint = `drop the decimal point: \`${posText.replace(/\..*$/, '')}\``;
        else if (/^-\d+$/.test(posText)) hint = 'positions cannot be negative';
        else if (RE_UINT.test(posText)) hint = 'POS must fit in a 32-bit signed integer (at most 2147483647)';
        ctx.report(V.posInvalid, starts[1]!, starts[1]! + posText.length, `POS \`${show(posText)}\` is not a valid position`, { hint });
      }
    }
    // Ordering and contig bookkeeping
    if (chrom !== '') {
      if (chrom !== this.chrom) {
        if (this.seenChroms.has(chrom)) {
          if (!this.warned.notContiguous.has(chrom)) {
            this.warned.notContiguous.add(chrom);
            ctx.report(V.chromNotContiguous, starts[0]!, starts[0]! + chrom.length, `records for \`${show(chrom)}\` resume here after records of other contigs`, { hint: 'sort the file with `bcftools sort`' });
          }
        } else {
          this.seenChroms.add(chrom);
          if (this.contigs.size > 0 && !this.contigs.has(chrom) && !this.warned.contig.has(chrom)) {
            this.warned.contig.add(chrom);
            const alt = chrom.startsWith('chr') ? chrom.slice(3) : 'chr' + chrom;
            ctx.report(V.chromUndeclared, starts[0]!, starts[0]! + chrom.length, `contig \`${show(chrom)}\` is not declared in any \`##contig\` line`, {
              hint: this.contigs.has(alt) ? `the header declares \`${alt}\`: header and records use different naming (\`chr\` prefix); rename with \`bcftools annotate --rename-chrs\`` : `add \`##contig=<ID=${chrom}>\` to the header (e.g. \`bcftools reheader --fai ref.fa.fai\`)`,
            });
          }
        }
        this.chrom = chrom;
        this.pos = pos;
        this.samePos.clear();
      } else if (pos < 0) {
        // unusable position: already reported
      } else if (pos < this.pos) {
        ctx.report(V.unsorted, starts[1]!, starts[1]! + posText.length, `position ${pos} comes after ${this.pos} on \`${show(chrom)}\``, { hint: 'sort the file with `bcftools sort`' });
        this.pos = pos;
        this.samePos.clear();
      } else if (pos > this.pos) {
        this.pos = pos;
        this.samePos.clear();
      }
      const len = this.contigs.get(chrom);
      if (len !== undefined && len > 0 && pos > len + 1) {
        ctx.report(V.posBeyondContig, starts[1]!, starts[1]! + posText.length, `position ${pos} is beyond the end of \`${show(chrom)}\` (declared length ${len})`, { hint: 'the header and the records probably refer to different reference builds' });
      }
    }
    // ID
    const id = fields[2]!;
    if (id !== '' && id !== '.') {
      if (/\s/.test(id)) ctx.report(V.idInvalid, starts[2]!, starts[2]! + id.length, `ID \`${show(id)}\` contains whitespace`, { hint: 'separate several identifiers with `;`, without spaces' });
      else if (id.includes(';')) {
        const parts = id.split(';');
        if (parts.includes('')) ctx.report(V.idInvalid, starts[2]!, starts[2]! + id.length, 'ID has an empty entry (stray `;`)', { hint: 'remove the extra semicolon' });
        else if (new Set(parts).size !== parts.length) ctx.report(V.idInvalid, starts[2]!, starts[2]! + id.length, 'ID lists the same identifier twice');
      }
    }
    // REF
    const ref = fields[3]!;
    if (ref !== '' && !RE_BASES.test(ref)) {
      const s3 = starts[3]!;
      if (RE_IUPAC.test(ref)) {
        const at = ref.search(/[^ACGTNacgtn]/);
        ctx.report(V.refAmbiguous, s3 + at, s3 + at + 1, `REF contains the IUPAC ambiguity code \`${ref[at]}\``, { hint: 'only A, C, G, T and N are allowed: use the alphabetically first base the code stands for (`bcftools norm --check-ref s` does this)' });
      } else {
        let hint = 'REF is one or more of A, C, G, T, N';
        if (ref === '.' || ref === '-' || ref === '*') hint = 'REF cannot be empty or missing: for an insertion, give the reference base before it and start ALT with the same base (e.g. REF=`A`, ALT=`ATG`)';
        else if (/^[<[\]]/.test(ref)) hint = 'symbolic alleles and breakends belong in ALT';
        else if (/\s/.test(ref)) hint = 'REF contains whitespace; check that the columns are separated by tabs';
        ctx.report(V.refInvalid, s3, s3 + ref.length, `REF \`${show(ref)}\` is not a sequence of bases`, { hint });
      }
    }
    // ALT
    const alt = fields[4]!;
    let nAlt = 0;
    if (alt !== '' && alt !== '.') {
      const s4 = starts[4]!;
      const alleles = alt.includes(',') ? alt.split(',') : [alt];
      nAlt = alleles.length;
      let off = s4;
      const seen = alleles.length > 1 ? new Set<string>() : null;
      const refUpper = ref.toUpperCase();
      for (const a of alleles) {
        const end = off + a.length;
        if (a === '') {
          ctx.report(V.altInvalid, off === s4 ? off : off - 1, off === s4 ? off + 1 : off, 'empty ALT allele (stray comma)', { hint: 'remove the extra comma, or write `.` if there is no alternate allele' });
        } else if (RE_BASES.test(a)) {
          if (a.toUpperCase() === refUpper) ctx.report(V.altDuplicate, off, end, `ALT allele \`${show(a)}\` is identical to REF`, { hint: 'write `.` for a non-variant site' });
        } else if (a === '*') {
          // spanning deletion; fine from 4.2, tolerated earlier
        } else if (a[0] === '<') {
          if (!/^<[^<>,\s]+>$/.test(a)) {
            ctx.report(V.altInvalid, off, end, `symbolic allele \`${show(a)}\` is malformed`, { hint: 'the form is `<ID>` with no whitespace, commas or nested brackets' });
          } else {
            const sid = a.slice(1, -1);
            if (sid !== '*' && sid !== 'NON_REF' && !this.alts.has(sid) && !this.warned.alt.has(sid)) {
              this.warned.alt.add(sid);
              ctx.report(V.altUndeclared, off, end, `symbolic allele \`${show(a)}\` has no \`##ALT=<ID=${show(sid)},...>\` line`, { hint: `add \`##ALT=<ID=${sid},Description="...">\` to the header` });
            }
          }
        } else if (RE_BREAKEND.test(a) || RE_SINGLE_BREAKEND.test(a)) {
          // breakend notation
        } else if (RE_BREAKEND_BARE.test(a)) {
          ctx.report(V.altInvalid, off, end, `breakend \`${show(a)}\` has no bases on either side`, { hint: 'a breakend replaces a reference base: write it before or after the brackets, e.g. `C[1:100[` or `]1:100]C`' });
        } else {
          let hint = 'an ALT allele is bases (A, C, G, T, N), `*`, a symbolic allele `<ID>`, or a breakend';
          if (a === '-') hint = 'for a deletion, include the reference base before it in both REF and ALT (e.g. REF=`ATG`, ALT=`A`)';
          else if (a === '.') hint = '`.` means "no alternate allele" and must stand alone';
          else if (RE_IUPAC.test(a)) hint = 'IUPAC ambiguity codes are not allowed as bases; list the concrete alleles, or use a symbolic allele declared with `##ALT`';
          else if (/[>/]/.test(a) && /^[ACGTN]+[>/][ACGTN]+$/i.test(a)) hint = 'write the alternate allele only; REF already holds the reference allele';
          else if (/\s/.test(a)) hint = 'ALT contains whitespace; check that the columns are separated by tabs';
          ctx.report(V.altInvalid, off, end, `ALT allele \`${show(a)}\` is not valid`, { hint });
        }
        if (seen) {
          const k = a.toUpperCase();
          if (a !== '' && seen.has(k)) ctx.report(V.altDuplicate, off, end, `ALT allele \`${show(a)}\` is listed twice`, { hint: 'list each alternate allele once' });
          seen.add(k);
        }
        off = end + 1;
      }
    }
    // Duplicate records at the same site
    if (chrom !== '' && pos >= 0 && !/[<[\]]/.test(alt)) {
      const key = ref + '\t' + alt;
      if (this.samePos.has(key)) ctx.report(V.duplicateRecord, 0, starts[5] !== undefined ? starts[5] - 1 : text.length, `duplicate record: \`${show(chrom)}\`:${pos} ${show(ref, 20)}>${show(alt, 20)} already appeared`, { hint: 'remove exact duplicates with `bcftools norm -d exact`' });
      else this.samePos.add(key);
    }
    // QUAL
    const qual = fields[5]!;
    if (qual !== '' && qual !== '.' && !RE_FLOAT.test(qual)) {
      ctx.report(V.qualInvalid, starts[5]!, starts[5]! + qual.length, `QUAL \`${show(qual)}\` is not a number`, {
        hint: /^\d+,\d+$/.test(qual) ? `use a decimal point: \`${qual.replace(',', '.')}\`` : qual === 'PASS' ? 'this looks like a FILTER value: a column may be missing before it' : 'write a number, or `.` if unknown',
      });
    }
    else if (qual.charCodeAt(0) === 45 && Number(qual) < 0) {
      ctx.report(V.qualNegative, starts[5]!, starts[5]! + qual.length, `QUAL ${show(qual, 20)} is negative`, { hint: 'QUAL is a Phred-scaled probability and cannot be below 0; write `.` if it is unknown' });
    }
    // FILTER
    const filter = fields[6]!;
    if (filter !== '' && filter !== '.' && filter !== 'PASS') this.filterField(filter, starts[6]!, ctx);
    // INFO
    const info = fields[7]!;
    if (info !== '' && info !== '.') this.infoField(info, starts[7]!, nAlt, pos, ctx);
    // FORMAT and samples
    if (limit > 8 && !hasEmpty) this.samplesFields(fields, starts, limit, nAlt, ctx);
    else if (limit > 9 && fields[8] !== '') this.samplesFields(fields, starts, limit, nAlt, ctx);
  }

  private filterField(filter: string, s: number, ctx: Context): void {
    const parts = filter.split(';');
    const seen = parts.length > 1 ? new Set<string>() : null;
    let off = s;
    for (const p of parts) {
      const end = off + p.length;
      if (p === '') ctx.report(V.filterInvalid, off === s ? off : off - 1, off === s ? off + 1 : off, 'empty FILTER entry (stray `;`)', { hint: 'remove the extra semicolon' });
      else if (/\s/.test(p)) ctx.report(V.filterInvalid, off, end, `filter name \`${show(p)}\` contains whitespace`, { hint: 'filter names cannot contain spaces; separate several filters with `;`' });
      else if (p === '0') ctx.report(V.filterInvalid, off, end, '`0` is reserved and cannot be used as a filter name', { hint: 'write `PASS` if the record passed all filters, or `.` if none were applied' });
      else if (p === 'PASS' && parts.length > 1) ctx.report(V.filterInvalid, off, end, '`PASS` cannot be combined with failed filters', { hint: 'list only the filters that failed' });
      else if (p === '.') ctx.report(V.filterInvalid, off, end, '`.` (no filters applied) cannot be combined with filter names');
      else {
        if (seen) { if (seen.has(p)) ctx.report(V.filterInvalid, off, end, `filter \`${show(p)}\` is listed twice`); seen.add(p); }
        if (!this.filters.has(p) && !this.warned.filter.has(p)) {
          this.warned.filter.add(p);
          const near = suggest(p, [...this.filters.keys(), 'PASS']);
          ctx.report(V.filterUndeclared, off, end, `filter \`${show(p)}\` has no \`##FILTER\` line`, { hint: near ? `did you mean \`${near}\`? otherwise add \`##FILTER=<ID=${p},Description="...">\`` : `add \`##FILTER=<ID=${p},Description="...">\` to the header` });
        }
      }
      off = end + 1;
    }
  }

  private infoField(info: string, s: number, nAlt: number, pos: number, ctx: Context): void {
    if (this.version < 43 && info.includes(' ')) {
      const at = info.indexOf(' ');
      ctx.report(V.infoWhitespace, s + at, s + at + 1, `INFO contains a space, which ${this.versionName} does not allow`, { hint: 'replace spaces (commonly with `_`), or declare `##fileformat=VCFv4.3`, which allows spaces inside values' });
    }
    const entries = info.split(';');
    const seen = entries.length > 1 ? new Set<string>() : null;
    let off = s;
    let reportedEmpty = false;
    for (const e of entries) {
      const end = off + e.length;
      if (e === '') {
        if (!reportedEmpty) {
          reportedEmpty = true;
          const trailing = end === s + info.length;
          ctx.report(V.infoEmptyEntry, off === s ? off : off - 1, off === s ? off + 1 : off, trailing ? 'INFO ends with a semicolon' : 'empty INFO entry (two semicolons in a row)', { hint: 'remove the extra semicolon' });
        }
        off = end + 1;
        continue;
      }
      const eq = e.indexOf('=');
      const key = eq < 0 ? e : e.slice(0, eq);
      const value = eq < 0 ? null : e.slice(eq + 1);
      if (key === '') {
        ctx.report(V.infoMalformed, off, end, `INFO entry \`${show(e)}\` has no key before \`=\``, { hint: 'entries are `KEY=value` or a bare `FLAG`' });
        off = end + 1;
        continue;
      }
      if (!(RE_KEY.test(key) || key === '1000G') && (this.version >= 43 || /\s/.test(key))) {
        ctx.report(V.infoMalformed, off, off + key.length, `INFO key \`${show(key)}\` must match \`[A-Za-z_][0-9A-Za-z_.]*\``, {
          hint: /^\s|\s$/.test(key) ? 'remove the space around the key' : 'rename the key here and in its `##INFO` line',
        });
        off = end + 1;
        continue;
      }
      if (seen) {
        if (seen.has(key)) ctx.report(V.infoDuplicateKey, off, off + key.length, `INFO key \`${show(key)}\` appears twice in this record`, { hint: 'keep one of the two entries' });
        seen.add(key);
      }
      const declared = this.info.get(key);
      const def = declared ?? this.defOf('INFO', key);
      if (!declared && !this.warned.info.has(key)) {
        {
          this.warned.info.add(key);
          const near = suggest(key, [...this.info.keys()]);
          ctx.report(V.infoUndeclared, off, off + key.length, `INFO key \`${show(key)}\` has no \`##INFO\` line`, {
            hint: near ? `did you mean \`${near}\`? otherwise add \`##INFO=<ID=${key},Number=.,Type=String,Description="...">\`` : def ? `add \`##INFO=<ID=${key},Number=${def.number},Type=${def.type},Description="...">\` to the header` : `add \`##INFO=<ID=${key},Number=...,Type=...,Description="...">\` to the header`,
          });
        }
      }
      if (!def) {
        // unknown, undeclared key: nothing to check its value against
      } else if (value === null) {
        if (def.type !== 'Flag') ctx.report(V.infoFlagValue, off, end, `\`${key}\` is declared as ${def.type} but has no value here`, { hint: `write \`${key}=<value>\`, or \`${key}=.\` if it is missing`, notes: [declaredNote(def)] });
      } else if (value === '') {
        ctx.report(V.infoMalformed, off + eq, off + eq + 1, `INFO key \`${key}\` has \`=\` but no value`, { hint: `write \`${key}=.\` for a missing value` });
      } else if (def.type === 'Flag') {
        if (value !== '1' && value !== '0') {
          ctx.report(V.infoFlagValue, off + eq, end, `\`${key}\` is a Flag and takes no value, but has \`=${show(value, 20)}\``, { hint: `write just \`${key}\``, notes: [declaredNote(def)] });
        }
      } else if (value !== '.') {
        this.checkValues(false, key, def, value, off + eq + 1, nAlt, 2, ctx);
        if (this.reserved('INFO', key)) this.reservedInfoValue(key, value, off + eq + 1, ctx);
      }
      if (key === 'END' && value !== null && pos >= 0 && RE_UINT.test(value) && Number(value) < pos) {
        ctx.report(V.infoEndBeforePos, off, end, `END=${value} is before POS ${pos}`, { hint: 'END is the last reference base covered by the record, so END ≥ POS' });
      }
      off = end + 1;
    }
  }

  /** Check the count and type of a comma-separated value list against its declaration. */
  private checkValues(sample: boolean, key: string, def: FieldDef, value: string, col: number, nAlt: number, ploidy: number, ctx: Context): void {
    const single = !value.includes(',');
    const count = single ? 1 : value.split(',').length;
    const num = def.number;
    let expected = -1;
    let why = '';
    if (num === 'A') { expected = nAlt; why = `one per ALT allele (${nAlt})`; }
    else if (num === 'R') { expected = nAlt + 1; why = `one per allele including REF (${nAlt + 1})`; }
    else if (num === 'G') { if (sample) { expected = genotypeCount(ploidy, nAlt + 1); why = `one per genotype (ploidy ${ploidy}, ${plural(nAlt + 1, 'allele')}: ${expected})`; } }
    else if (num !== '.' && RE_UINT.test(num)) { expected = Number(num); why = `Number=${num}`; }
    // Widely used conventions that every parser accepts: a String with a fixed Number that packs its own separators
    // (GATK AS_* annotations), and a Character list written without commas (GATK RNC). Strict mode still reports them.
    const packed = ctx.profile !== 'strict' && ((def.type === 'String' && RE_UINT.test(num)) || (def.type === 'Character' && single && value.length === expected));
    if (packed) return;
    if (expected >= 0 && count !== expected && !(expected === 0 && nAlt === 0)) {
      ctx.report(sample ? V.sampleCount : V.infoCount, col, col + value.length, `\`${key}\` has ${plural(count, 'value')} but its declaration requires ${why}`, {
        hint: num === 'A' || num === 'R' || num === 'G' ? 'per-allele values must be updated whenever alleles are split, merged or removed (`bcftools norm` does this for declared tags)' : `give exactly ${expected}, or change \`Number\` in the header`,
        notes: [def.line ? `declared as Number=${num},Type=${def.type} on line ${def.line}` : `\`${key}\` is a reserved key that the specification defines as Number=${num},Type=${def.type}`],
      });
    }
    const type = def.type;
    if (type === 'String') return;
    let off = col;
    const vals = single ? [value] : value.split(',');
    for (const v of vals) {
      if (v !== '.') {
        if (type === 'Integer') {
          if (!RE_INT.test(v)) {
            ctx.report(sample ? V.sampleType : V.infoType, off, off + Math.max(1, v.length), v === '' ? `\`${key}\` has an empty value in its list` : `\`${key}\` is declared as Integer but has the value \`${show(v, 24)}\``, {
              hint: v === '' ? 'write `.` for a missing value' : RE_FLOAT.test(v) ? 'round the value, or declare the key as `Type=Float`' : /^(na|nan|null|none|-)$/i.test(v) ? 'write `.` for a missing value' : 'an Integer is digits with an optional sign',
              notes: [declaredNote(def)],
            });
            return;
          }
          const x = Number(v);
          if (x > INT_MAX || x < INT_MIN_OK) {
            ctx.report(V.integerRange, off, off + v.length, `\`${key}\` value ${show(v, 24)} does not fit in a 32-bit signed integer`, { hint: 'the valid range is −2147483640 to 2147483647; declare the key as `Type=Float` or `Type=String` if it needs larger values' });
            return;
          }
        } else if (type === 'Float') {
          if (!RE_FLOAT.test(v)) {
            ctx.report(sample ? V.sampleType : V.infoType, off, off + Math.max(1, v.length), v === '' ? `\`${key}\` has an empty value in its list` : `\`${key}\` is declared as Float but has the value \`${show(v, 24)}\``, {
              hint: v === '' || /^(na|null|none|-)$/i.test(v) ? 'write `.` for a missing value' : 'a Float looks like `0.5`, `3`, `1e-5`, `inf` or `nan`',
              notes: [declaredNote(def)],
            });
            return;
          }
        } else if (type === 'Character') {
          if (v.length !== 1 && !/^%[0-9A-Fa-f]{2}$/.test(v)) {
            ctx.report(sample ? V.sampleType : V.infoType, off, off + Math.max(1, v.length), `\`${key}\` is declared as Character but has the value \`${show(v, 24)}\``, { hint: 'a Character is exactly one character; declare the key as `Type=String` for longer values', notes: [declaredNote(def)] });
            return;
          }
        }
      }
      off += v.length + 1;
    }
  }

  /** Constraints the specification places on the values of reserved INFO keys beyond their type. */
  private reservedInfoValue(key: string, value: string, col: number, ctx: Context): void {
    if (NON_NEGATIVE_INFO.has(key)) {
      const at = value.search(/(^|,)-\d/);
      if (at >= 0) ctx.report(V.reservedValue, col + (value[at] === ',' ? at + 1 : at), col + value.length, `\`${key}\` cannot be negative`, { hint: `\`${key}\` is a count; write \`.\` if it is unknown` });
    } else if (key === 'AF') {
      let off = col;
      for (const v of value.split(',')) {
        if (v !== '.' && RE_FLOAT.test(v)) {
          const x = Number(v);
          if (x < 0 || x > 1) { ctx.report(V.reservedValue, off, off + v.length, `allele frequency ${show(v, 20)} is outside 0–1`, { hint: 'AF is a fraction between 0 and 1 (not a percentage)' }); break; }
        }
        off += v.length + 1;
      }
    } else if (key === 'CIGAR') {
      let off = col;
      for (const v of value.split(',')) {
        if (v !== '.' && !RE_CIGAR.test(v)) { ctx.report(V.reservedValue, off, off + v.length, `\`${show(v, 24)}\` is not a CIGAR string`, { hint: 'a CIGAR is one or more <length><operation> pairs, e.g. `3M1I2M`' }); break; }
        off += v.length + 1;
      }
    }
  }

  private formatSpec(fmt: string): FormatSpec {
    let spec = this.formatCache.get(fmt);
    if (spec) return spec;
    const { fields, starts } = splitWithOffsets(fmt, ':');
    spec = { keys: fields, starts, defs: fields.map((k) => this.defOf('FORMAT', k)), gtIndex: fields.indexOf('GT') };
    if (this.formatCache.size < 256) this.formatCache.set(fmt, spec);
    return spec;
  }

  private samplesFields(fields: string[], starts: number[], limit: number, nAlt: number, ctx: Context): void {
    const fmt = fields[8]!;
    const s8 = starts[8]!;
    const spec = this.formatSpec(fmt);
    const keys = spec.keys;
    // FORMAT column
    const seen = keys.length > 1 ? new Set<string>() : null;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const col = s8 + spec.starts[i]!;
      if (k === '') { ctx.report(V.formatMalformed, col === s8 ? col : col - 1, col === s8 ? col + 1 : col, 'empty FORMAT key (stray `:`)', { hint: 'remove the extra colon' }); continue; }
      if (!RE_KEY.test(k) && (this.version >= 43 || /[^0-9A-Za-z_.]/.test(k))) {
        ctx.report(V.formatMalformed, col, col + k.length, `FORMAT key \`${show(k)}\` must match \`[A-Za-z_][0-9A-Za-z_.]*\``, { hint: 'rename the key here and in its `##FORMAT` line' });
        continue;
      }
      if (this.version < 43 && /[_.]/.test(k) && ctx.enabled(V.formatKeyLegacy)) {
        ctx.report(V.formatKeyLegacy, col, col + k.length, `FORMAT key \`${k}\` contains \`${/[_.]/.exec(k)![0]}\`, which ${this.versionName} does not allow`, { hint: 'declare `##fileformat=VCFv4.3` (which allows `_` and `.` in keys), or rename the key' });
      }
      if (seen) { if (seen.has(k)) ctx.report(V.formatMalformed, col, col + k.length, `FORMAT key \`${k}\` is listed twice`, { hint: 'remove the repeated key and its values in every sample' }); seen.add(k); }
      if (!this.format.has(k) && !this.warned.format.has(k)) {
        this.warned.format.add(k);
        const near = suggest(k, [...this.format.keys()]);
        ctx.report(V.formatUndeclared, col, col + k.length, `FORMAT key \`${show(k)}\` has no \`##FORMAT\` line`, {
          hint: near ? `did you mean \`${near}\`? otherwise add \`##FORMAT=<ID=${k},Number=...,Type=...,Description="...">\`` : k === 'GT' ? 'add `##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">` to the header' : `add \`##FORMAT=<ID=${k},Number=...,Type=...,Description="...">\` to the header`,
        });
      }
    }
    if (spec.gtIndex > 0) {
      const col = s8 + spec.starts[spec.gtIndex]!;
      ctx.report(V.gtNotFirst, col, col + 2, `GT must be the first FORMAT key, but it is number ${spec.gtIndex + 1}`, { hint: 'move GT (and the matching value in every sample) to the front' });
    }
    const reGt = this.version >= 44 ? RE_GT_PREFIX : RE_GT;
    const nKeys = keys.length;
    for (let s = 9; s < limit; s++) {
      const sample = fields[s]!;
      if (sample === '' || sample === '.') continue;
      const base = starts[s]!;
      // Fast path: a lone, well-formed genotype.
      if (nKeys === 1 && spec.gtIndex === 0 && !sample.includes(':')) { this.genotype(sample, base, nAlt, reGt, ctx); continue; }
      const parts = sample.includes(':') ? sample.split(':') : [sample];
      if (parts.length > nKeys) {
        let extra = base;
        for (let i = 0; i < nKeys; i++) extra += parts[i]!.length + 1;
        ctx.report(V.sampleFieldCount, extra - 1, base + sample.length, `sample has ${plural(parts.length, 'field')} but FORMAT lists ${nKeys} (\`${show(fmt, 40)}\`)`, { hint: 'a value may contain a `:`, or FORMAT is missing a key' });
        continue;
      }
      let off = base;
      let ploidy = 2;
      for (let i = 0; i < parts.length; i++) {
        const v = parts[i]!;
        if (v === '') {
          ctx.report(V.sampleEmptyField, off === base ? off : off - 1, off === base ? off + 1 : off + (i === parts.length - 1 ? 0 : 1), `\`${keys[i]}\` is empty in this sample`, { hint: 'write `.` for a missing value' });
        } else if (i === spec.gtIndex) {
          ploidy = this.genotype(v, off, nAlt, reGt, ctx);
        } else if (v !== '.') {
          const def = spec.defs[i];
          if (def && (def.type !== 'String' || def.number !== '.')) this.checkValues(true, keys[i]!, def, v, off, nAlt, ploidy, ctx);
        }
        off += v.length + 1;
      }
    }
  }

  /** Validate one GT value; returns its ploidy. */
  private genotype(gt: string, col: number, nAlt: number, re: RegExp, ctx: Context): number {
    if (gt.length === 3) {
      // Overwhelmingly common: single-digit diploid calls.
      const a = gt.charCodeAt(0), sep = gt.charCodeAt(1), b = gt.charCodeAt(2);
      if ((sep === 47 || sep === 124) && (a === 46 || (a >= 48 && a <= 57 && a - 48 <= nAlt)) && (b === 46 || (b >= 48 && b <= 57 && b - 48 <= nAlt))) return 2;
    }
    if (!re.test(gt)) {
      let hint = 'a genotype is allele indices joined by `/` or `|`, e.g. `0/1`, `1|0`, `./.`';
      if (/^[ACGTN]+[/|][ACGTN]+$/i.test(gt)) hint = 'GT holds allele indices, not bases: 0 is REF, 1 the first ALT allele, and so on';
      else if (/^[01]$/.test(gt) === false && /^\d+[\\,;-]\d+$/.test(gt)) hint = 'separate alleles with `/` (unphased) or `|` (phased)';
      else if (/^(na|nan|null|-)$/i.test(gt)) hint = 'write `./.` (or `.` for a haploid call) for a missing genotype';
      else if (/^[/|]/.test(gt)) hint = 'a leading phasing indicator is only allowed from VCF 4.4';
      ctx.report(V.gtInvalid, col, col + gt.length, `genotype \`${show(gt, 24)}\` is not valid`, { hint });
      return 2;
    }
    let ploidy = 0;
    let i = gt.charCodeAt(0) === 47 || gt.charCodeAt(0) === 124 ? 1 : 0;
    const n = gt.length;
    while (i < n) {
      let j = i;
      while (j < n && gt.charCodeAt(j) !== 47 && gt.charCodeAt(j) !== 124) j++;
      ploidy++;
      if (gt[i] !== '.') {
        const idx = Number(gt.slice(i, j));
        if (idx > nAlt) {
          ctx.report(V.gtInvalid, col + i, col + j, `genotype refers to allele ${idx}, but the record has ${nAlt === 0 ? 'no ALT alleles' : plural(nAlt, 'ALT allele')}`, { hint: `allele indices run from 0 (REF) to ${nAlt}` });
          return ploidy;
        }
      }
      i = j + 1;
    }
    return ploidy;
  }
}

export const vcf: FormatDef = {
  id: 'vcf',
  name: 'VCF',
  description: 'Variant Call Format 4.1–4.5 (text)',
  extensions: ['.vcf'],
  bgzipExpected: true,
  finalNewlineRequired: true,
  rules: Object.values(V),
  sniff(head) {
    if (head[0]?.startsWith('##fileformat=VCF')) return 1;
    for (const l of head) if (/^#CHROM[\t ]+POS[\t ]+ID[\t ]+REF/.test(l)) return 0.95;
    return 0;
  },
  create() { return new VcfValidator(); },
};

function declaredNote(def: FieldDef): string {
  return def.line ? `declared on line ${def.line}` : 'a reserved key: its Number and Type are fixed by the specification';
}
