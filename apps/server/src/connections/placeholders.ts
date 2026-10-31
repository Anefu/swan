import { randomBytes } from "node:crypto";

/**
 * A session's stand-in for a credential value. AWS key placeholders look like real keys so SDKs
 * accept them; the proxy recognises them in signatures and re-signs.
 */
export function newPlaceholder(ref: string, field?: string): string {
  const name = ref.slice(ref.indexOf("/") + 1).replace(/[^A-Za-z0-9_]/g, "_");
  if (field === "accessKeyId") return `ASIASWAN${randomBytes(6).toString("hex").toUpperCase()}`;
  if (field === "secretAccessKey") return `phs${randomBytes(30).toString("base64url")}`.slice(0, 40);
  if (field === "sessionToken") return `phs_${name}_token_${randomBytes(24).toString("hex")}`;
  return `phs_${name}_${randomBytes(8).toString("hex")}`;
}

/** Placeholder keys for one credential: `value`, or the three AWS fields. */
export const placeholderKeys = (ref: string, kind: string) =>
  kind === "aws-sigv4" ? [`${ref}.accessKeyId`, `${ref}.secretAccessKey`, `${ref}.sessionToken`] : [ref];
