// Real credential values on their way back to the sandbox, rewritten to placeholders.
import { Transform, type TransformCallback } from "node:stream";
import zlib from "node:zlib";

/** Streams a body through, rewriting real secret values back to placeholders. */
export class Redactor extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private keep: number;
  constructor(private pairs: { secret: Buffer; placeholder: Buffer }[]) {
    super();
    this.keep = Math.max(0, ...pairs.map((p) => p.secret.length - 1));
  }

  /**
   * Each value as sent, and as a server might echo it: percent-encoded, JSON-escaped and base64.
   * `exact` adds pairs seen in this request (a Basic header as sent). Longest first.
   */
  static pairs(values: { secret: string; placeholder: string }[], exact: { secret: string; placeholder: string }[] = []) {
    const forms = [(v: string) => v, encodeURIComponent, (v: string) => JSON.stringify(v).slice(1, -1), (v: string) => Buffer.from(v).toString("base64")];
    const out = new Map<string, string>();
    for (const { secret, placeholder } of values) for (const f of forms) if (!out.has(f(secret))) out.set(f(secret), f(placeholder));
    for (const e of exact) out.set(e.secret, e.placeholder);
    return [...out].sort((a, b) => b[0].length - a[0].length).map(([secret, placeholder]) => ({ secret: Buffer.from(secret), placeholder: Buffer.from(placeholder) }));
  }

  text(value: string): string {
    return this.replaceAll(Buffer.from(value)).toString();
  }

  private replaceAll(buf: Buffer): Buffer {
    for (const { secret, placeholder } of this.pairs) {
      let idx = buf.indexOf(secret);
      if (idx === -1) continue;
      const parts: Buffer[] = [];
      let from = 0;
      while (idx !== -1) {
        parts.push(buf.subarray(from, idx), placeholder);
        from = idx + secret.length;
        idx = buf.indexOf(secret, from);
      }
      parts.push(buf.subarray(from));
      buf = Buffer.concat(parts);
    }
    return buf;
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    const data = this.replaceAll(Buffer.concat([this.pending, chunk]));
    const cut = Math.max(0, data.length - this.keep);
    this.pending = data.subarray(cut);
    cb(null, data.subarray(0, cut));
  }
  _flush(cb: TransformCallback) {
    cb(null, this.replaceAll(this.pending));
  }
}

/** A decoder for a response encoding, so it can be scanned; null when Swan can't read it. */
export function decoder(encoding: string): Transform | null {
  const e = encoding.trim().toLowerCase();
  if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
  if (e === "deflate") return zlib.createInflate();
  if (e === "br") return zlib.createBrotliDecompress();
  return null;
}
