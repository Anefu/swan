import { promises as fs } from "node:fs";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export const uiContentType = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/** A file of the UI build for a URL path; null for anything else (the single-page app), never outside the build. */
export async function resolveUiFile(root: string, urlPath: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || !path.extname(decoded) || decoded.endsWith("/index.html")) return null;
  const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (!file.startsWith(root + path.sep)) return null;
  const st = await fs.stat(file).catch(() => null);
  return st?.isFile() ? file : null;
}

/**
 * The UI page's policy: its own scripts only, no plugins or frames, and network access only to
 * itself (the API comes through swan://app) and the server's WebSocket. Images only from the
 * app and the server: a remote image in a reply would be fetched from this Mac's network, outside
 * the egress proxy, with whatever the agent put in its URL.
 */
export function appCsp(port: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ws://127.0.0.1:${port}`,
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
