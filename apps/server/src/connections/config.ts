import { z } from "zod";

export const CONNECTION_NAME = /^[a-z0-9-]{1,32}$/;
export const CREDENTIAL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `{{credential:conn/NAME}}`, `{{credential:NAME.field}}`, `{{credential:NAME|basic}}`; `{{secret:NAME}}` is the old alias. */
export const CREDENTIAL_REF =
  /\{\{\s*(?:credential:(?:([a-z0-9-]{1,32})\/)?([A-Za-z0-9_-]{1,64})(?:\.(accessKeyId|secretAccessKey|sessionToken|username|value))?(\|basic)?|secret:([A-Za-z_][A-Za-z0-9_]*))\s*\}\}/g;

export interface CredentialRefMatch {
  connection?: string;
  name: string;
  field?: "accessKeyId" | "secretAccessKey" | "sessionToken" | "username" | "value";
  basic: boolean;
  legacy: boolean; // {{secret:NAME}}
}

export function parseRefMatch(m: RegExpMatchArray): CredentialRefMatch {
  if (m[5]) return { name: m[5], basic: false, legacy: true };
  return { connection: m[1], name: m[2], field: m[3] as CredentialRefMatch["field"], basic: !!m[4], legacy: false };
}

export function credentialRefs(text: string): CredentialRefMatch[] {
  return [...text.matchAll(CREDENTIAL_REF)].map(parseRefMatch);
}

/** Exact host or `*.domain`; never a bare `*`, a path or a port. */
export const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const HostPattern = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => HOST_PATTERN.test(s), { message: "must be a hostname or *.domain" });

/** 90, "90s", "5m", "2h" -> milliseconds. */
const Duration = z.union([z.number().positive(), z.string().regex(/^\d+(ms|s|m|h)$/)]).transform((v) => {
  if (typeof v === "number") return v * 1000;
  const n = Number(/^\d+/.exec(v)![0]);
  const unit = v.replace(/^\d+/, "");
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit as "ms" | "s" | "m" | "h"];
});

const Inject = z.strictObject({
  header: z.string().regex(/^[A-Za-z0-9-]+$/),
  format: z.string().refine((s) => s.includes("{value}"), { message: "must contain {value}" }).default("{value}"),
});

const StaticCredential = z.strictObject({
  hosts: z.array(HostPattern).default([]),
  inject: Inject.optional(),
  env: z.string().regex(ENV_NAME).optional(), // sandbox variable; default: the credential name
  substituteInBody: z.boolean().optional(), // also swap placeholders in JSON/form request bodies (< 1 MB)
});

const StaticConnection = z.strictObject({
  type: z.literal("static"),
  credentials: z.record(z.string().regex(CREDENTIAL_NAME, "credential names are [A-Za-z0-9_-]{1,64}"), StaticCredential).default({}),
});

const CommandConnection = z.strictObject({
  type: z.literal("command"),
  command: z.array(z.string().min(1)).min(1),
  hosts: z.array(HostPattern).min(1),
  renewBefore: Duration.prefault("5m"),
  timeout: Duration.prefault("60s"),
  skill: z.string().optional(),
});

export const ConnectionsSchema = z.record(
  z.string().regex(CONNECTION_NAME, "connection names are [a-z0-9-]{1,32}"),
  z.discriminatedUnion("type", [StaticConnection, CommandConnection]),
);

export type ConnectionsConfig = z.infer<typeof ConnectionsSchema>;
export type ConnectionConfig = ConnectionsConfig[string];
export type StaticConnectionConfig = z.infer<typeof StaticConnection>;
export type CommandConnectionConfig = z.infer<typeof CommandConnection>;
export type StaticCredentialConfig = z.infer<typeof StaticCredential>;

export const RULE_APIS = ["kubernetes", "aws", "http"] as const;

export const RuleSchema = z.strictObject({
  credential: z.string().regex(/^[A-Za-z0-9_*?-]{1,64}$/, "credential must be a name or glob within the connection"),
  api: z.enum(RULE_APIS),
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});
export type Rule = z.infer<typeof RuleSchema>;

export const PersonaConnectionsSchema = z.record(
  z.string().regex(CONNECTION_NAME, "connection names are [a-z0-9-]{1,32}"),
  z.strictObject({ rules: z.array(RuleSchema).default([]) }),
);

// ---------- wrapper protocol v1 (mirrors docs/connection-protocol-v1.schema.json) ----------

const Timestamp = z.iso.datetime({ offset: true });
const WrapperHost = z.string().regex(/^(\*\.)?[A-Za-z0-9.-]+$/).transform((s) => s.toLowerCase());

const CredBase = {
  name: z.string().regex(CREDENTIAL_NAME),
  hosts: z.array(WrapperHost).min(1),
  expiresAt: Timestamp.optional(),
  ca: z.string().includes("-----BEGIN CERTIFICATE-----").optional(),
};

export const WrapperCredential = z.discriminatedUnion("kind", [
  z.strictObject({ ...CredBase, kind: z.literal("bearer"), value: z.string().min(1) }),
  z.strictObject({ ...CredBase, kind: z.literal("header"), value: z.string().min(1), inject: Inject.required() }),
  z.strictObject({ ...CredBase, kind: z.literal("basic"), username: z.string(), value: z.string().min(1) }),
  z.strictObject({ ...CredBase, kind: z.literal("aws-sigv4"), accessKeyId: z.string().min(16), secretAccessKey: z.string().min(1), sessionToken: z.string().optional() }),
]);
export type WrapperCredential = z.infer<typeof WrapperCredential>;

export const WrapperFile = z.strictObject({
  path: z.string().regex(/^~\/(?!.*(^|\/)\.\.(\/|$)).+/, "files must be under ~/ without .."),
  content: z.string().max(262_144),
  mode: z.string().regex(/^0[0-7]{3}$/).optional(),
});
export type WrapperFile = z.infer<typeof WrapperFile>;

export const DeviceCodeLine = z.strictObject({
  type: z.literal("device_code"),
  verificationUri: z.url(),
  verificationUriComplete: z.url().optional(),
  userCode: z.string().min(1).max(64),
  expiresAt: Timestamp,
});

export const ResultLine = z
  .strictObject({
    type: z.literal("result"),
    state: z.enum(["ready", "login_required", "error"]),
    message: z.string().max(2000).optional(),
    expiresAt: Timestamp.optional(),
    credentials: z.array(WrapperCredential).max(64).optional(),
    files: z.array(WrapperFile).max(64).optional(),
    env: z.record(z.string().regex(ENV_NAME), z.string()).optional(),
  })
  .refine((r) => r.state !== "ready" || r.credentials !== undefined, { message: "a ready result needs credentials" });
export type ResultLine = z.infer<typeof ResultLine>;

export const WrapperLine = z.union([DeviceCodeLine, ResultLine]);

/** Is every host matched by `pattern` also matched by `bound`? */
export function hostWithin(pattern: string, bound: string): boolean {
  const p = pattern.toLowerCase();
  const b = bound.toLowerCase();
  if (p === b) return true;
  if (b === "*" || p === "*") return false;
  const host = p.startsWith("*.") ? p.slice(2) : p;
  if (!b.startsWith("*.")) return false;
  return host.endsWith(b.slice(1));
}
