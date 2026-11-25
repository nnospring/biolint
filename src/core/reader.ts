/**
 * Splits a byte stream into lines without decoding it.
 *
 * A line ends at LF. A CR immediately before the LF is reported through `crlf` and is not part of the line.
 * Lines longer than `maxPiece` bytes are delivered in pieces (`partial` = more of the same line follows).
 */
export type LineSink = (bytes: Uint8Array, offset: number, crlf: boolean, partial: boolean, continued: boolean, terminated: boolean) => void;

export class LineSplitter {
  private carry: Uint8Array | null = null;
  private carryLen = 0;
  private offset = 0;       // file offset of the start of the pending line piece
  private inLong = false;   // currently inside a line that has already emitted a piece
  private skipping = false; // inside an oversized line whose remaining bytes are being thrown away
  private readonly sink: LineSink;
  private readonly maxPiece: number;
  private readonly discardOversize: boolean;

  /**
   * @param maxPiece longest run of bytes held for one line before it is delivered as a piece
   * @param discardOversize instead of delivering pieces, report an oversized line once (as an empty partial piece)
   *        and drop the rest of it without buffering; for formats whose records cannot be checked piecewise
   */
  constructor(sink: LineSink, maxPiece = 1 << 22, discardOversize = false) {
    this.sink = sink;
    this.maxPiece = maxPiece;
    this.discardOversize = discardOversize;
  }

  push(chunk: Uint8Array): void {
    let pos = 0;
    const n = chunk.length;
    while (pos < n) {
      const nl = chunk.indexOf(10, pos);
      if (nl < 0) {
        this.stash(chunk, pos, n);
        return;
      }
      this.emitLine(chunk, pos, nl);
      pos = nl + 1;
    }
  }

  /**
   * Flush the last line if the stream did not end with a newline. Returns true when it did not.
   * With `discard`, an unterminated last line is dropped instead (the stream was cut off mid-line).
   */
  end(discard = false): boolean {
    if (discard || this.skipping) { this.carry = null; this.carryLen = 0; this.inLong = false; this.skipping = false; return false; }
    if (this.carryLen > 0 || this.inLong) {
      const bytes = this.carry ? this.carry.subarray(0, this.carryLen) : new Uint8Array(0);
      const cont = this.inLong;
      this.carry = null; this.carryLen = 0; this.inLong = false;
      this.sink(bytes, this.offset, false, false, cont, false);
      this.offset += bytes.length;
      return true;
    }
    return false;
  }

  private emitLine(chunk: Uint8Array, start: number, nl: number): void {
    if (this.skipping) {
      this.skipping = false; this.inLong = false; this.carryLen = 0;
      this.offset += nl - start + 1;
      this.sink(EMPTY, this.offset, false, false, true, true);
      return;
    }
    let bytes: Uint8Array;
    if (this.carryLen > 0) {
      this.append(chunk, start, nl);
      bytes = this.carry!.subarray(0, this.carryLen);
    } else {
      bytes = chunk.subarray(start, nl);
    }
    let len = bytes.length;
    const crlf = len > 0 && bytes[len - 1] === 13;
    if (crlf) len--;
    const cont = this.inLong;
    const lineBytes = len === bytes.length ? bytes : bytes.subarray(0, len);
    const total = bytes.length + 1;
    this.carryLen = 0; this.inLong = false;
    this.sink(lineBytes, this.offset, crlf, false, cont, true);
    this.offset += total;
  }

  private stash(chunk: Uint8Array, start: number, end: number): void {
    if (this.skipping) { this.offset += end - start; return; }
    if (this.discardOversize && this.carryLen + (end - start) >= this.maxPiece) {
      const at = this.offset;
      this.offset += this.carryLen + (end - start);
      this.carry = null; this.carryLen = 0; this.skipping = true; this.inLong = true;
      this.sink(EMPTY, at, false, true, false, false);
      return;
    }
    this.append(chunk, start, end);
    while (this.carryLen >= this.maxPiece) {
      // Deliver a piece but keep the final byte: it may be the CR of a CRLF.
      const take = this.carryLen - 1;
      const piece = this.carry!.slice(0, take);
      const last = this.carry![take]!;
      const cont = this.inLong;
      this.carry![0] = last; this.carryLen = 1; this.inLong = true;
      this.sink(piece, this.offset, false, true, cont, false);
      this.offset += take;
    }
  }

  private append(chunk: Uint8Array, start: number, end: number): void {
    const add = end - start;
    if (!this.carry || this.carry.length < this.carryLen + add) {
      const cap = Math.max(1 << 16, (this.carryLen + add) * 2);
      const next = new Uint8Array(Math.min(cap, Math.max(this.carryLen + add, this.maxPiece + (1 << 16))));
      if (this.carry) next.set(this.carry.subarray(0, this.carryLen));
      this.carry = next;
    }
    this.carry.set(chunk.subarray(start, end), this.carryLen);
    this.carryLen += add;
  }
}

const EMPTY = new Uint8Array(0);
const utf8 = new TextDecoder('utf-8');
type NodeBufferLike = { from(ab: ArrayBufferLike, off: number, len: number): { latin1Slice(a: number, b: number): string } };
const NodeBuffer: NodeBufferLike | undefined = (globalThis as unknown as { Buffer?: NodeBufferLike }).Buffer;

/** Decode bytes one byte per UTF-16 unit (true ISO-8859-1), so string indices equal byte offsets and char codes equal bytes. */
export function decodeLatin1(bytes: Uint8Array): string {
  const n = bytes.length;
  if (n < 32) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]!);
    return s;
  }
  if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, n).latin1Slice(0, n);
  let s = '';
  for (let i = 0; i < n; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(n, i + 8192)) as unknown as number[]);
  return s;
}

/** Decode bytes as UTF-8 for display, replacing invalid sequences. */
export function decodeUtf8(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** Number of Unicode code points in the first `byteIndex` bytes when read as UTF-8 (invalid bytes count as one each). */
export function codePointIndex(bytes: Uint8Array, byteIndex: number): number {
  let cp = 0;
  const end = Math.min(byteIndex, bytes.length);
  for (let i = 0; i < end; i++) if ((bytes[i]! & 0xc0) !== 0x80) cp++;
  return cp;
}
