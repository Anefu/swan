import type { IncomingMessage, ServerResponse } from "node:http";

export interface Req {
  method: string;
  url: URL; // absolute, built from the Host header
  rawUrl: string; // as sent, for signature checks
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export const header = (r: Req, name: string): string | undefined => {
  const v = r.headers[name];
  return Array.isArray(v) ? v.join(",") : v;
};

export function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), ...extra });
  res.end(body);
}

export const json = (res: ServerResponse, status: number, value: unknown, type = "application/json", extra: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(value), type, extra);

export const xml = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) =>
  send(res, status, `<?xml version="1.0" encoding="UTF-8"?>\n${body}`, "text/xml", extra);

export const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

export function formParams(r: Req): URLSearchParams {
  const q = new URLSearchParams(r.url.search);
  const type = header(r, "content-type") ?? "";
  if (r.method === "POST" && type.includes("application/x-www-form-urlencoded")) {
    for (const [k, v] of new URLSearchParams(r.body.toString("utf8"))) q.set(k, v);
  }
  return q;
}

/** Decode an aws-chunked body (signed or unsigned chunks, optional trailers). */
export function decodeAwsChunked(body: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < body.length) {
    const eol = body.indexOf("\r\n", i);
    if (eol === -1) break;
    const size = parseInt(body.subarray(i, eol).toString("latin1").split(";")[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(body.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}
