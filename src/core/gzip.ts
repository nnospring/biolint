/** What the first bytes of a file say about its compression container. */
export interface GzipInfo { gzip: boolean; bgzf: boolean }

/** The fixed 28-byte empty block that ends every complete BGZF file. */
export const BGZF_EOF = new Uint8Array([
  0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x06, 0x00, 0x42, 0x43, 0x02, 0x00, 0x1b, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

export function inspectGzip(head: Uint8Array): GzipInfo {
  if (head.length < 4 || head[0] !== 0x1f || head[1] !== 0x8b) return { gzip: false, bgzf: false };
  return { gzip: true, bgzf: bgzfBlockSize(head, 0) > 0 };
}

/** Total size of the BGZF block starting at `pos`, 0 if this is not a BGZF block header, -1 if more bytes are needed. */
export function bgzfBlockSize(b: Uint8Array, pos: number): number {
  if (b.length - pos < 12) return -1;
  if (b[pos] !== 0x1f || b[pos + 1] !== 0x8b || b[pos + 2] !== 8 || (b[pos + 3]! & 4) === 0) return 0;
  const xlen = b[pos + 10]! | (b[pos + 11]! << 8);
  if (b.length - pos < 12 + xlen) return -1;
  let p = pos + 12;
  const end = p + xlen;
  while (p + 4 <= end) {
    const slen = b[p + 2]! | (b[p + 3]! << 8);
    if (b[p] === 66 && b[p + 1] === 67 && slen === 2) return (b[p + 4]! | (b[p + 5]! << 8)) + 1;
    p += 4 + slen;
  }
  return 0;
}

/** True when `tail` (the last bytes of the raw file) ends with the BGZF end-of-file marker. */
export function endsWithBgzfEof(tail: Uint8Array): boolean {
  if (tail.length < BGZF_EOF.length) return false;
  const off = tail.length - BGZF_EOF.length;
  for (let i = 0; i < BGZF_EOF.length; i++) if (tail[off + i] !== BGZF_EOF[i]) return false;
  return true;
}

export interface GunzipOutcome { bytesOut: number; error?: string; bgzfEof: boolean }

type DSFormat = 'gzip' | 'deflate-raw';
const makeDS = (format: DSFormat) => new DecompressionStream(format as CompressionFormat) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

async function inflateRaw(data: Uint8Array, size: number): Promise<Uint8Array> {
  const ds = makeDS('deflate-raw');
  const writer = ds.writable.getWriter();
  const writing = writer.write(data).then(() => writer.close());
  writing.catch(() => {});
  const out = new Uint8Array(size);
  let o = 0;
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (o + value.length > size) throw new Error('block is larger than its header says');
    out.set(value, o);
    o += value.length;
  }
  await writing;
  if (o !== size) throw new Error('block is shorter than its header says');
  return out;
}

/**
 * Decompress gzip or BGZF using the platform's DecompressionStream (browsers, Node.js 18+).
 * BGZF is read block by block, so multi-member files work even where the platform stream stops after one member.
 * Output produced before an error is still delivered.
 */
export async function gunzipWeb(first: Uint8Array, rest: AsyncIterable<Uint8Array>, sink: (chunk: Uint8Array) => void): Promise<GunzipOutcome> {
  let bytesOut = 0;
  const emit = (c: Uint8Array) => { if (c.length) { bytesOut += c.length; sink(c); } };
  async function* all(): AsyncGenerator<Uint8Array> { yield first; for await (const c of rest) yield c; }

  if (bgzfBlockSize(first, 0) > 0 || bgzfBlockSize(first, 0) === -1) {
    let buf: Uint8Array = new Uint8Array(0);
    let lastEmpty = false;
    try {
      for await (const chunk of all()) {
        buf = buf.length ? concat2(buf, chunk) : chunk;
        let pos = 0;
        for (;;) {
          const size = bgzfBlockSize(buf, pos);
          if (size === -1 || (size > 0 && buf.length - pos < size)) break;
          if (size === 0) return { bytesOut, error: 'a block without a BGZF header follows BGZF blocks (damaged or mixed-format file)', bgzfEof: false };
          const xlen = buf[pos + 10]! | (buf[pos + 11]! << 8);
          const isize = (buf[pos + size - 4]! | (buf[pos + size - 3]! << 8) | (buf[pos + size - 2]! << 16) | (buf[pos + size - 1]! << 24)) >>> 0;
          lastEmpty = isize === 0;
          if (isize > 0) emit(await inflateRaw(buf.subarray(pos + 12 + xlen, pos + size - 8), isize));
          pos += size;
        }
        buf = pos === buf.length ? new Uint8Array(0) : buf.slice(pos);
      }
    } catch (e) {
      return { bytesOut, error: (e as Error).message || 'corrupt BGZF block', bgzfEof: false };
    }
    if (buf.length) return { bytesOut, error: 'the file ends in the middle of a BGZF block', bgzfEof: false };
    return { bytesOut, bgzfEof: lastEmpty };
  }

  // Plain gzip. A file may hold several members back to back (`cat a.gz b.gz`, a common way to merge FASTQ lanes).
  // Some platforms stop with an error after the first member, so members are fed one at a time: when the platform
  // stream rejects the bytes after a member, the member boundary is found from its trailer and decoding resumes there.
  const input = all()[Symbol.asyncIterator]();
  let leftover: Uint8Array | null = null;       // bytes already read that belong to the next member
  let lastFour = new Uint8Array(0);             // last 4 bytes of the whole input (ISIZE of the final member)
  const noteTail = (c: Uint8Array) => { if (c.length >= 4) lastFour = c.slice(c.length - 4); else { const t = new Uint8Array(Math.min(4, lastFour.length + c.length)); const k = t.length - c.length; t.set(lastFour.subarray(lastFour.length - k)); t.set(c, k); lastFour = t; } };
  const WINDOW = 1 << 23;
  for (;;) {
    const ds = makeDS('gzip');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    const written: Uint8Array[] = [];           // sliding window of what this member's decoder was given
    let writtenLen = 0;
    let memberOut = 0;
    let inputDone = false;
    const write = (async () => {
      for (;;) {
        let chunk: Uint8Array;
        if (leftover) { chunk = leftover; leftover = null; }
        else { const n = await input.next(); if (n.done) { inputDone = true; break; } chunk = n.value; noteTail(chunk); }
        written.push(chunk); writtenLen += chunk.length;
        while (written.length > 2 && writtenLen - written[0]!.length >= WINDOW) writtenLen -= written.shift()!.length;
        await writer.write(chunk);
      }
      await writer.close();
    })();
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        memberOut += value.length;
        emit(value);
      }
    })();
    const [w, r] = await Promise.allSettled([write, read]);
    if (w.status === 'fulfilled' && r.status === 'fulfilled') {
      // Guard against a platform that silently ignores later members: the file's last 4 bytes must be this member's size.
      const isize = lastFour.length === 4 ? (lastFour[0]! | (lastFour[1]! << 8) | (lastFour[2]! << 16) | (lastFour[3]! << 24)) >>> 0 : memberOut >>> 0;
      if (isize !== memberOut >>> 0 && inputDone && (await multiMemberBehaviour()) === 'ignores') {
        return { bytesOut, error: 'the file holds several gzip members and this browser read only the first; decompress it with `zcat` and check the output instead', bgzfEof: false };
      }
      return { bytesOut, bgzfEof: false };
    }
    // Decoding failed. If a complete member was decoded and another gzip header follows it, carry on from there.
    try { await reader.cancel(); } catch { /* already errored */ }
    const win = written.length === 1 ? written[0]! : concatAll(written, writtenLen);
    const want = memberOut >>> 0;
    let next = -1;
    for (let p = 18; p + 4 <= win.length; p++) {
      if (win[p] === 0x1f && win[p + 1] === 0x8b && win[p + 2] === 8 && (win[p + 3]! & 0xe0) === 0 &&
        ((win[p - 4]! | (win[p - 3]! << 8) | (win[p - 2]! << 16) | (win[p - 1]! << 24)) >>> 0) === want) { next = p; break; }
    }
    if (next < 0 || memberOut === 0) {
      const reason = (r.status === 'rejected' ? r.reason : (w as PromiseRejectedResult).reason) as Error | undefined;
      return { bytesOut, error: inputDone || next < 0 ? 'unexpected end of compressed data or corrupt stream' + (reason?.message ? ` (${reason.message})` : '') : 'corrupt gzip stream', bgzfEof: false };
    }
    leftover = win.slice(next);
  }
}

/** Two gzip members holding "a" and "b". */
const TWO_MEMBERS = Uint8Array.from('1f8b08000000000002134b040043beb7e8010000001f8b08000000000002134b0200f9efbe7101000000'.match(/../g)!.map((h) => parseInt(h, 16)));
let probe: Promise<'reads-all' | 'errors' | 'ignores'> | null = null;

/** What the platform's gzip DecompressionStream does with data after the first member (probed once). */
function multiMemberBehaviour(): Promise<'reads-all' | 'errors' | 'ignores'> {
  probe ??= (async () => {
    const ds = makeDS('gzip');
    const writer = ds.writable.getWriter();
    const w = writer.write(TWO_MEMBERS).then(() => writer.close());
    w.catch(() => {});
    const reader = ds.readable.getReader();
    let out = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; out += value.length; }
      await w;
    } catch { return 'errors' as const; }
    return out === 2 ? 'reads-all' as const : 'ignores' as const;
  })();
  return probe;
}

function concatAll(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
