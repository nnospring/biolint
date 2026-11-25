import { Linter } from './core/engine.ts';
import type { LintOptions, LintResult } from './core/types.ts';
import { formats } from './formats/index.ts';
import { gunzipWeb, inspectGzip } from './core/gzip.ts';

export type { Diagnostic, Example, Fix, FormatDef, Level, LineEdit, LintOptions, LintResult, Profile, RuleMeta, Severity } from './core/types.ts';
export { Linter } from './core/engine.ts';
export { formats, allRules, findRule, textRules } from './formats/index.ts';
export { renderPretty, renderCompact, renderSummary } from './render/pretty.ts';
export { renderJson, renderSarif, renderGithub } from './render/machine.ts';
export { applyFixes } from './core/fix.ts';
export { comparePair } from './formats/fastq/pair.ts';
export { inspectGzip } from './core/gzip.ts';
export { VERSION } from './version.ts';

const encoder = new TextEncoder();

/** Create an incremental linter: `push()` decompressed chunks, then `end()`. */
export function createLinter(options: LintOptions = {}): Linter {
  return new Linter(formats, options);
}

/** Lint content that is already in memory (text, or uncompressed bytes). */
export function lintText(content: string | Uint8Array, options: LintOptions = {}): LintResult {
  const linter = new Linter(formats, options);
  linter.push(typeof content === 'string' ? encoder.encode(content) : content);
  return linter.end();
}

/**
 * Lint a stream of raw file bytes, decompressing gzip/BGZF transparently.
 * Works in browsers and in Node.js (`file.stream()`, `Readable.toWeb(...)`, `fetch().body`).
 */
export async function lintStream(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, options: LintOptions = {}): Promise<LintResult> {
  const linter = new Linter(formats, options);
  const iter = toAsyncIterable(stream);
  const it = iter[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return linter.end();
  const rest: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => it.next() }) };
  const info = inspectGzip(first.value);
  if (!info.gzip) {
    linter.push(first.value);
    for await (const chunk of rest) linter.push(chunk);
    return linter.end();
  }
  const outcome = await gunzipWeb(first.value, rest, (chunk) => linter.push(chunk));
  linter.setContainer({ kind: info.bgzf ? 'bgzf' : 'gzip', eofMarker: outcome.bgzfEof, ...(outcome.error ? { error: outcome.error } : {}) });
  return linter.end();
}

function toAsyncIterable(s: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in s) return s as AsyncIterable<Uint8Array>;
  const reader = (s as ReadableStream<Uint8Array>).getReader();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const r = await reader.read();
          return r.done ? { done: true, value: undefined } : { done: false, value: r.value };
        },
        async return() { reader.releaseLock(); return { done: true, value: undefined }; },
      };
    },
  };
}
