import type { Diagnostic, LineEdit } from './types.ts';

export interface FixOutcome {
  /** The repaired content. Identical to the input when nothing applied. */
  output: Uint8Array;
  /** Number of diagnostics whose fix was applied. */
  applied: number;
  /** Fixes skipped because they overlapped one that was applied first. */
  skipped: number;
}

const encoder = new TextEncoder();

/**
 * Apply every fix attached to `diagnostics` to `content` (the uncompressed bytes that were linted).
 * Line edits use 1-based byte columns relative to the line as it was linted (after any byte-order mark).
 */
export function applyFixes(content: Uint8Array, diagnostics: readonly Diagnostic[]): FixOutcome {
  let stripBom = false, lf = false, finalNewline = false, trimBlank = false;
  let applied = 0, skipped = 0;
  const edits = new Map<number, LineEdit[]>();
  for (const d of diagnostics) {
    if (!d.fix) continue;
    applied++;
    if (d.fix.transform === 'strip-bom') stripBom = true;
    else if (d.fix.transform === 'lf-line-endings') lf = true;
    else if (d.fix.transform === 'final-newline') finalNewline = true;
    else if (d.fix.transform === 'trim-trailing-blank-lines') trimBlank = true;
    for (const e of d.fix.edits ?? []) {
      const list = edits.get(e.line);
      if (list) list.push(e); else edits.set(e.line, [e]);
    }
  }
  if (applied === 0) return { output: content, applied: 0, skipped: 0 };

  const hasBom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
  if (trimBlank) {
    let end = content.length;
    // Drop empty lines (LF or CRLF) after the last line that has content.
    for (;;) {
      if (end >= 2 && content[end - 1] === 10 && content[end - 2] === 10) end -= 1;
      else if (end >= 3 && content[end - 1] === 10 && content[end - 2] === 13 && content[end - 3] === 10) end -= 2;
      else break;
    }
    content = content.subarray(0, end);
  }
  let pos = hasBom ? 3 : 0;
  const out: Uint8Array[] = [];
  if (hasBom && !stripBom) out.push(content.subarray(0, 3));
  const n = content.length;
  let lineNo = 0;
  const NL = new Uint8Array([10]);
  while (pos < n) {
    lineNo++;
    let nl = content.indexOf(10, pos);
    const terminated = nl >= 0;
    if (!terminated) nl = n;
    let end = nl;
    const crlf = terminated && end > pos && content[end - 1] === 13;
    if (crlf) end--;
    const lineEdits = edits.get(lineNo);
    if (lineEdits) {
      lineEdits.sort((a, b) => a.column - b.column);
      let cursor = pos;
      let lastEnd = 0;
      for (const e of lineEdits) {
        if (e.column < lastEnd) { skipped++; continue; }
        const a = pos + e.column - 1, b = pos + e.endColumn - 1;
        if (a < cursor || b > end || a > b) { skipped++; continue; }
        out.push(content.subarray(cursor, a));
        if (e.text) out.push(encoder.encode(e.text));
        cursor = b;
        lastEnd = e.endColumn;
      }
      out.push(content.subarray(cursor, end));
    } else {
      out.push(content.subarray(pos, end));
    }
    if (terminated) out.push(crlf && !lf ? content.subarray(end, nl + 1) : NL);
    else if (finalNewline) out.push(NL);
    pos = nl + 1;
  }
  let total = 0;
  for (const c of out) total += c.length;
  const output = new Uint8Array(total);
  let o = 0;
  for (const c of out) { output.set(c, o); o += c.length; }
  return { output, applied: applied - skipped, skipped };
}
