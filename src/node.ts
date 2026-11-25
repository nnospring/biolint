import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { Linter } from './core/engine.ts';
import { endsWithBgzfEof, inspectGzip } from './core/gzip.ts';
import type { LintOptions, LintResult } from './core/types.ts';
import { formats } from './formats/index.ts';

/**
 * Lint a file on disk (or standard input when `path` is `-`), streaming and decompressing gzip/BGZF as needed.
 * Rejects only for I/O errors such as a missing file; problems in the content are diagnostics.
 */
export function lintFile(path: string, options: LintOptions = {}): Promise<LintResult> {
  const input: Readable = path === '-' ? process.stdin : createReadStream(path, { highWaterMark: 1 << 20 });
  return lintReadable(input, { ...options, filename: options.filename ?? (path === '-' ? '<stdin>' : path) });
}

/** Lint any Node.js readable stream of raw file bytes. */
export function lintReadable(input: Readable, options: LintOptions = {}): Promise<LintResult> {
  return new Promise((resolve, reject) => {
    const linter = new Linter(formats, options);
    let first = true;
    let gz: ReturnType<typeof createGunzip> | null = null;
    let kind: 'gzip' | 'bgzf' = 'gzip';
    let tail: Uint8Array = new Uint8Array(0);
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      if (gz) linter.setContainer({ kind, eofMarker: endsWithBgzfEof(tail), ...(error ? { error } : {}) });
      try { resolve(linter.end()); } catch (e) { reject(e as Error); }
    };
    const keepTail = (chunk: Uint8Array) => {
      if (chunk.length >= 28) tail = chunk.subarray(chunk.length - 28);
      else { const t = new Uint8Array(Math.min(28, tail.length + chunk.length)); const keep = t.length - chunk.length; t.set(tail.subarray(tail.length - keep), 0); t.set(chunk, keep); tail = t; }
    };
    input.on('data', (chunk: Buffer) => {
      if (first) {
        first = false;
        const info = inspectGzip(chunk);
        if (info.gzip) {
          kind = info.bgzf ? 'bgzf' : 'gzip';
          gz = createGunzip({ chunkSize: 1 << 20 });
          gz.on('data', (out: Buffer) => { try { linter.push(out); } catch (e) { settled = true; reject(e as Error); input.destroy(); } });
          gz.on('end', () => finish());
          gz.on('error', (e: NodeJS.ErrnoException) => {
            const msg = e.code === 'Z_BUF_ERROR' ? 'unexpected end of compressed data' : e.code === 'Z_DATA_ERROR' ? `corrupt compressed data (${e.message})` : e.message;
            input.destroy();
            finish(msg);
          });
        }
      }
      try {
        if (gz) { keepTail(chunk); if (!gz.write(chunk)) { input.pause(); gz.once('drain', () => input.resume()); } }
        else linter.push(chunk);
      } catch (e) { settled = true; reject(e as Error); input.destroy(); }
    });
    input.on('end', () => { if (gz) gz.end(); else finish(); });
    input.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}
