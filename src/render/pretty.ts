import type { Diagnostic, LintResult, Severity } from '../core/types.ts';

export interface PrettyOptions {
  color?: boolean;
  /** Show the offending line with a caret underline. Default true. */
  context?: boolean;
}

const C = { red: '31', yellow: '33', blue: '34', cyan: '36', bold: '1', dim: '2', green: '32' } as const;
type Paint = (code: keyof typeof C | (keyof typeof C)[], s: string) => string;
const painter = (on: boolean): Paint => (code, s) => {
  if (!on || !s) return s;
  const codes = (Array.isArray(code) ? code : [code]).map((c) => C[c]).join(';');
  return `\x1b[${codes}m${s}\x1b[0m`;
};
const SEV_COLOR: Record<Severity, keyof typeof C> = { error: 'red', warning: 'yellow', info: 'cyan' };

/** Terminal cells a code point occupies (enough for CJK and full-width forms). */
function width(cp: number): number {
  if (cp < 0x1100) return 1;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  if (cp >= 0x200b && cp <= 0x200f) return 0;
  return 1;
}

/** Turn an excerpt into a displayable line plus the cell range to underline. */
function frame(d: Diagnostic): { text: string; start: number; length: number } | null {
  const ex = d.excerpt;
  if (!ex) return null;
  let text = ex.clippedStart ? '…' : '';
  let cells = text.length;
  let start = -1, end = -1;
  let i = 1;
  for (const ch of ex.text) {
    if (i === ex.column) start = cells;
    if (i === ex.endColumn) end = cells;
    const cp = ch.codePointAt(0)!;
    let shown = ch;
    let w = width(cp);
    if (cp === 9) { shown = '→'; w = 1; }
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) { shown = '␦'; w = 1; }
    else if (cp === 0xa0 || w === 0) { shown = '␣'; w = 1; }
    text += shown;
    cells += w;
    i++;
  }
  if (start < 0) start = cells;
  if (end < 0) end = cells;
  if (ex.clippedEnd) text += '…';
  return { text, start, length: Math.max(1, end - start) };
}

function location(filename: string, d: Diagnostic): string {
  return d.line > 0 ? `${filename}:${d.line}${d.column > 0 ? ':' + d.column : ''}` : filename;
}

/** rustc-style report for one file. */
export function renderPretty(result: LintResult, options: PrettyOptions = {}): string {
  const paint = painter(!!options.color);
  const out: string[] = [];
  for (const d of result.diagnostics) {
    const sev = SEV_COLOR[d.severity];
    out.push(`${paint([sev, 'bold'], `${d.severity}[${d.code}]`)}${paint('bold', `: ${d.message}`)}`);
    const gutter = d.line > 0 ? String(d.line).length : 1;
    const pad = ' '.repeat(gutter);
    out.push(`${pad}${paint('blue', '-->')} ${location(result.filename, d)}`);
    const f = options.context === false ? null : frame(d);
    if (f) {
      out.push(`${pad} ${paint('blue', '|')}`);
      out.push(`${paint('blue', String(d.line).padStart(gutter) + ' |')} ${f.text}`);
      out.push(`${pad} ${paint('blue', '|')} ${' '.repeat(f.start)}${paint([sev, 'bold'], '^'.repeat(f.length))}`);
    }
    if (d.hint) out.push(`${pad} ${paint('blue', '=')} ${paint('bold', 'help')}: ${d.hint}`);
    for (const n of d.notes ?? []) out.push(`${pad} ${paint('blue', '=')} ${paint('bold', 'note')}: ${n}`);
    if (d.fix) out.push(`${pad} ${paint('blue', '=')} ${paint('bold', 'fix')}: ${d.fix.title} ${paint('dim', '(--fix)')}`);
    if (d.spec) out.push(`${pad} ${paint('blue', '=')} ${paint('dim', `spec: ${d.spec}`)}`);
    out.push('');
  }
  const hidden = Object.entries(result.byRule).filter(([, r]) => r.count > r.shown);
  if (hidden.length) {
    out.push(paint('dim', 'Not all occurrences are shown (use --max-per-rule 0 to see every one):'));
    for (const [code, r] of hidden) out.push(paint('dim', `  ${code}  ${r.count.toLocaleString('en-US')} occurrences, ${r.shown} shown`));
    out.push('');
  }
  out.push(renderSummary(result, options));
  return out.join('\n');
}

/** One line: what the file is and how many problems it has. */
export function renderSummary(result: LintResult, options: PrettyOptions = {}): string {
  const paint = painter(!!options.color);
  const { error, warning, info } = result.counts;
  const parts: string[] = [];
  if (error) parts.push(paint(['red', 'bold'], `${error.toLocaleString('en-US')} error${error === 1 ? '' : 's'}`));
  if (warning) parts.push(paint(['yellow', 'bold'], `${warning.toLocaleString('en-US')} warning${warning === 1 ? '' : 's'}`));
  if (info) parts.push(paint('cyan', `${info.toLocaleString('en-US')} note${info === 1 ? '' : 's'}`));
  const facts = [result.format === 'unknown' ? 'unknown format' : formatLabel(result)];
  for (const key of ['records', 'sequences', 'reads', 'features', 'samples']) {
    const v = result.stats[key];
    if (typeof v === 'number' && (v > 0 || key === 'records')) facts.push(`${v.toLocaleString('en-US')} ${v === 1 ? key.replace(/s$/, '') : key}`);
  }
  const verdict = parts.length ? parts.join(', ') : paint(['green', 'bold'], 'no problems');
  const mark = error ? paint('red', '✖') : warning ? paint('yellow', '⚠') : paint('green', '✔');
  return `${mark} ${paint('bold', result.filename)} ${paint('dim', `(${facts.join(', ')})`)}: ${verdict}`;
}

function formatLabel(result: LintResult): string {
  const v = result.stats['version'];
  return typeof v === 'string' ? v : result.format.toUpperCase();
}

/** One line per diagnostic, `file:line:col: severity[CODE] message`, as editors and grep expect. */
export function renderCompact(result: LintResult): string {
  return result.diagnostics.map((d) => `${location(result.filename, d)}: ${d.severity}[${d.code}] ${d.message}${d.hint ? ` (hint: ${d.hint})` : ''}`).join('\n');
}
