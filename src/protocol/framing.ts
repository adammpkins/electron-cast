import { CastProtocolError } from "./errors.ts";

/** Maximum Cast v2 message body in bytes (Chromium's kMaxMessageSize). */
export const MAX_MESSAGE_SIZE = 65536;

const HEADER_SIZE = 4;
const EMPTY_BODY = Buffer.alloc(0);

/** Wrap a body in the 4-byte big-endian length prefix used on the Cast socket. */
export function frame(body: Uint8Array): Buffer {
  if (body.length > MAX_MESSAGE_SIZE) {
    throw new RangeError(`body of ${body.length} bytes exceeds MAX_MESSAGE_SIZE (${MAX_MESSAGE_SIZE})`);
  }
  const out = Buffer.allocUnsafe(HEADER_SIZE + body.length);
  out.writeUInt32BE(body.length, 0);
  out.set(body, HEADER_SIZE);
  return out;
}

/** Reassembles length-prefixed frames from an arbitrarily chunked byte stream. */
export class FrameDecoder {
  private readonly queue: Buffer[] = [];
  private queuedBytes = 0;
  private pendingLength: number | null = null;
  private dead = false;

  /** Number of bytes currently held for an incomplete frame. */
  get bufferedBytes(): number {
    return this.queuedBytes + (this.pendingLength === null ? 0 : HEADER_SIZE);
  }

  /** Feed a chunk of the stream; returns every complete body in order. */
  push(chunk: Uint8Array): Buffer[] {
    if (this.dead) throw new CastProtocolError("stream is dead after a protocol error");
    if (chunk.byteLength > 0) {
      const copy = Buffer.from(chunk);
      this.queue.push(copy);
      this.queuedBytes += copy.length;
    }
    const bodies: Buffer[] = [];
    for (;;) {
      if (this.pendingLength === null) {
        if (this.queuedBytes < HEADER_SIZE) break;
        const length = this.readHeader().readUInt32BE(0);
        if (length > MAX_MESSAGE_SIZE) {
          this.dead = true;
          throw new CastProtocolError(`declared length ${length} exceeds MAX_MESSAGE_SIZE (${MAX_MESSAGE_SIZE})`);
        }
        this.pendingLength = length;
      }
      if (this.queuedBytes < this.pendingLength) break;
      bodies.push(this.readBody(this.pendingLength));
      this.pendingLength = null;
    }
    return bodies;
  }

  private readHeader(): Buffer {
    const header = Buffer.allocUnsafe(HEADER_SIZE);
    let filled = 0;
    while (filled < HEADER_SIZE) {
      const buf = this.queue[0]!;
      const n = Math.min(buf.length, HEADER_SIZE - filled);
      buf.copy(header, filled, 0, n);
      this.drainHead(n);
      filled += n;
    }
    return header;
  }

  private readBody(length: number): Buffer {
    if (length === 0) return EMPTY_BODY;
    const head = this.queue[0]!;
    if (head.length >= length) {
      const body = Buffer.from(head.subarray(0, length));
      this.drainHead(length);
      return body;
    }
    const pieces: Buffer[] = [];
    let size = 0;
    while (size < length) {
      const buf = this.queue[0]!;
      const n = Math.min(buf.length, length - size);
      pieces.push(buf.subarray(0, n));
      this.drainHead(n);
      size += n;
    }
    return Buffer.concat(pieces);
  }

  private drainHead(n: number): void {
    const buf = this.queue[0]!;
    if (n === buf.length) this.queue.shift();
    else this.queue[0] = buf.subarray(n);
    this.queuedBytes -= n;
  }
}
