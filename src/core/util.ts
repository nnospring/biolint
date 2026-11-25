const utf8 = new TextDecoder('utf-8');

/**
 * Make a slice of a line safe to quote in a message.
 * Input is a Latin-1 view of the bytes (one char per byte); output is the UTF-8 reading with control
 * characters made visible and long values shortened.
 */
export function show(s: string, max = 48): string {
  let out = s;
  if (/[\x80-\xff]/.test(s)) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    out = utf8.decode(b);
  }
  if (out.length > max) out = out.slice(0, max - 1) + '…';
  return out.replace(/[\x00-\x1f\x7f]/g, (c) => (c === '\t' ? '\\t' : c === '\r' ? '\\r' : c === '\n' ? '\\n' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
}

/** `1 record`, `2 records`. */
export function plural(n: number, word: string, pluralForm = word + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralForm}`;
}

/** Join names as `a, b or c`. */
export function oneOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
}

/** Closest candidate by edit distance, if it is close enough to be a plausible typo. */
export function suggest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  const w = word.toLowerCase();
  for (const c of candidates) {
    const d = editDistance(w, c.toLowerCase(), 3);
    if (d < bestD) { bestD = d; best = c; }
  }
  const limit = word.length <= 3 ? 1 : word.length <= 6 ? 2 : 3;
  return bestD <= limit ? best : undefined;
}

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Split on one character, returning the fields and the byte index where each starts. */
export function splitWithOffsets(text: string, sep: string): { fields: string[]; starts: number[] } {
  const fields: string[] = [];
  const starts: number[] = [];
  let pos = 0;
  for (;;) {
    const i = text.indexOf(sep, pos);
    starts.push(pos);
    if (i < 0) { fields.push(text.slice(pos)); break; }
    fields.push(text.slice(pos, i));
    pos = i + 1;
  }
  return { fields, starts };
}

/** Strict decimal integer (optional sign), no leading/trailing junk. */
export const isInt = (s: string): boolean => /^[+-]?\d+$/.test(s);
/** Non-negative decimal integer. */
export const isUInt = (s: string): boolean => /^\d+$/.test(s);
