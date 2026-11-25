/** Severity of a reported diagnostic. */
export type Severity = 'error' | 'warning' | 'info';
/** Level a rule runs at. `off` disables it. */
export type Level = Severity | 'off';
/** `default` follows what mainstream tools accept; `strict` follows the letter of each specification. */
export type Profile = 'default' | 'strict';

export interface Example {
  /** File content. Tabs are real tabs. */
  text: string;
  /** One line on what the example shows. */
  note?: string;
  /** Options to lint the example with (e.g. a strict-only rule). */
  profile?: Profile;
  /** For rules that apply to every format: the format this example is written in (default `fasta`). */
  format?: string;
  /** Format-specific options the example needs (the same keys as `-o <format>.<key>=<value>`). */
  options?: Record<string, unknown>;
}

/** Static description of one rule. The rule catalogue, the docs and the example tests are all generated from this. */
export interface RuleMeta {
  /** Stable identifier such as `VCF102`. Never reused. */
  code: string;
  /** Kebab-case name such as `info-type-invalid`. */
  name: string;
  /** Format id the rule belongs to (`vcf`, `fasta`, ... or `text`). */
  format: string;
  /** One-line summary, sentence case, no trailing period. */
  title: string;
  /** Level in the default profile. */
  level: Level;
  /** Level in the strict profile. Defaults to `level`. */
  strict?: Level;
  /** Why this matters and what usually causes it. Markdown. */
  explanation: string;
  /** Where the requirement comes from, e.g. `VCF 4.3 §1.4.2`. */
  spec?: string;
  /** True when biolint can repair every occurrence mechanically. */
  fixable?: boolean;
  /** At most this many occurrences are printed per file (the rest are counted). */
  maxShown?: number;
  examples?: { bad?: Example[]; good?: Example[] };
}

/** A line-local replacement. Columns are 1-based byte columns; `endColumn` is exclusive. */
export interface LineEdit {
  line: number;
  column: number;
  endColumn: number;
  text: string;
}

/** A mechanical repair attached to a diagnostic. */
export interface Fix {
  title: string;
  /** Replacements inside single lines. */
  edits?: LineEdit[];
  /** Whole-file transforms that cannot be expressed as line edits. */
  transform?: 'lf-line-endings' | 'strip-bom' | 'final-newline' | 'trim-trailing-blank-lines';
}

export interface Diagnostic {
  code: string;
  name: string;
  severity: Severity;
  message: string;
  /** 1-based line number; 0 when the diagnostic is about the file as a whole. */
  line: number;
  /** 1-based column in Unicode code points (a tab counts as one); 0 when not applicable. */
  column: number;
  /** Exclusive end column, same unit as `column`. */
  endColumn: number;
  /** 1-based column in bytes, for tools that seek. */
  byteColumn: number;
  /** A concrete suggestion for repairing the problem. */
  hint?: string;
  /** Extra context such as where a clashing declaration lives. */
  notes?: string[];
  /** Specification reference. */
  spec?: string;
  fix?: Fix;
  /** The offending line (or a window of it) for display. */
  excerpt?: { text: string; column: number; endColumn: number; clippedStart: boolean; clippedEnd: boolean };
}

export interface LintOptions {
  /** Format id. Detected from `filename` and content when omitted. */
  format?: string;
  /** Used for detection and messages. */
  filename?: string;
  profile?: Profile;
  /** Only run rules whose code or name starts with one of these. */
  select?: string[];
  /** Never report rules whose code or name starts with one of these. */
  ignore?: string[];
  /** Print at most this many diagnostics per rule per file (0 = no limit). Default 5. */
  maxPerRule?: number;
  /** Format-specific options, e.g. `{ fasta: { alphabet: 'dna' } }`. */
  formatOptions?: Record<string, Record<string, unknown>>;
}

export interface LintResult {
  filename: string;
  /** Detected or requested format id, or `unknown`. */
  format: string;
  /** How the format was chosen. */
  formatSource: 'option' | 'extension' | 'content' | 'none';
  diagnostics: Diagnostic[];
  /** Totals including occurrences that were counted but not printed. */
  counts: { error: number; warning: number; info: number };
  /** Total occurrences per rule code. */
  byRule: Record<string, { count: number; shown: number; severity: Severity; fixable: boolean }>;
  /** Format-specific summary numbers (records, samples, ...). */
  stats: Record<string, number | string>;
  lines: number;
  bytes: number;
}

/** One physical line handed to a format validator. Only valid during the call. */
export interface Line {
  /** 1-based line number. */
  no: number;
  /** Line content without its terminator. */
  bytes: Uint8Array;
  /** Content decoded one byte per character (Latin-1), so string indices equal byte offsets. */
  readonly text: string;
  /** Byte offset of the line start in the (decompressed) file. */
  offset: number;
  /** True when this piece does not end the physical line (only for validators with `segments`). */
  partial: boolean;
  /** True when this piece continues a line started by an earlier piece. */
  continued: boolean;
}

export interface ReportExtra {
  hint?: string;
  notes?: string[];
  fix?: Fix;
  /** Override the rule's spec reference (e.g. version-specific section). */
  spec?: string;
}

export interface Context {
  readonly profile: Profile;
  readonly filename: string;
  /** Options given for this format. */
  readonly options: Record<string, unknown>;
  /**
   * Report a problem on the line currently being processed.
   * `column` is a 0-based byte index into the line; `endColumn` is exclusive. Pass -1 for "whole line".
   */
  report(rule: RuleMeta, column: number, endColumn: number, message: string, extra?: ReportExtra): void;
  /** Report a problem that is not tied to the current line (`line` 0 = whole file). */
  reportAt(rule: RuleMeta, line: number, message: string, extra?: ReportExtra): void;
  /** True when the rule is switched on, to skip expensive checks. */
  enabled(rule: RuleMeta): boolean;
  /** Publish a summary number. */
  stat(key: string, value: number | string): void;
}

export interface Validator {
  line(line: Line, ctx: Context): void;
  end(ctx: Context): void;
}

export interface FormatDef {
  id: string;
  /** Display name, e.g. `VCF`. */
  name: string;
  /** One-line description for listings. */
  description: string;
  /** File name suffixes without compression suffix, lower case, e.g. `.vcf`. */
  extensions: string[];
  /** Score 0..1 that the leading lines of a file are this format. */
  sniff(head: string[]): number;
  /** True if the validator accepts lines in pieces (very long lines). */
  segments?: boolean;
  /** Empty lines can be part of a record (FASTQ reads of length zero), so the engine must not hold them back. */
  blankLinesAreData?: boolean;
  /** The specification requires the last line to be terminated (reported as TXT014 instead of TXT009). */
  finalNewlineRequired?: boolean;
  /** Tools usually index this format with bgzip + tabix/faidx, so plain gzip deserves a note. */
  bgzipExpected?: boolean;
  rules: RuleMeta[];
  create(ctx: Context): Validator;
}
