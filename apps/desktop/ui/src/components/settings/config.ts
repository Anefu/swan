// A persona's settings as the form edits them: defaults, the cleanup before saving, and validation.
import type { PersonaConfigView, SubagentsConfig } from "@ph/shared";
import { clone } from "../../util";

export function blankConfig(): PersonaConfigView {
  return {
    name: "",
    description: "",
    instructions: "",
    folders: [],
    networkAllow: [],
    networkInternal: [],
    networkOtherCredentials: [],
    connections: {},
    permissions: { default: "ask", allow: ["read_file", "list_dir", "glob", "grep", "load_skill"], ask: ["bash", "write_file", "edit_file"], deny: [] },
    skills: [],
    mcpServers: {},
    memory: { autoBrief: true, briefTokens: 2000, autoDream: true },
    subagents: subagentDefaults(),
    schedules: [],
    watchers: [],
    unattended: { allow: [], credentials: {}, maxTurnsPerDay: 30 },
  };
}

function subagentDefaults(): SubagentsConfig {
  return { agents: [], maxBackground: 4, maxTurns: 200 };
}

/** A server from before sub-agents sends no `subagents`; edit the defaults instead. */
export function withDefaults(v: PersonaConfigView): PersonaConfigView {
  return { ...v, subagents: v.subagents ?? subagentDefaults(), networkInternal: v.networkInternal ?? [], networkOtherCredentials: v.networkOtherCredentials ?? [] };
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

export type Errors = Record<string, string>;

export function cleaned(v: PersonaConfigView): PersonaConfigView {
  const x = clone(v);
  x.name = x.name.trim();
  x.networkAllow = x.networkAllow.map((h) => h.trim()).filter(Boolean);
  x.networkInternal = x.networkInternal.map((h) => h.trim()).filter(Boolean);
  x.networkOtherCredentials = (x.networkOtherCredentials ?? []).map((h) => h.trim()).filter(Boolean);
  for (const k of ["allow", "ask", "deny"] as const) x.permissions[k] = x.permissions[k].map((r) => r.trim()).filter(Boolean);
  x.folders = x.folders.map((f) => ({ ...f, path: f.path.trim(), ...(f.mount ? { mount: f.mount.trim() } : {}) }));
  x.subagents.agents = x.subagents.agents.map((a) => ({ name: a.name.trim(), model: a.model.trim() }));
  if (x.unattended) x.unattended.allow = x.unattended.allow.map((r) => r.trim()).filter(Boolean);
  for (const t of [...(x.schedules ?? []), ...(x.watchers ?? [])]) t.name = t.name.trim();
  for (const pc of Object.values(x.connections))
    pc.rules = pc.rules.map((r) => ({
      ...r,
      credential: r.credential.trim(),
      allow: patterns(r.allow),
      ask: patterns(r.ask),
      deny: patterns(r.deny),
    }));
  return x;
}

export function patterns(list: string[] | undefined): string[] {
  return (list ?? []).map((p) => p.trim()).filter(Boolean);
}

const RULE_CREDENTIAL_RE = /^[A-Za-z0-9_*?-]{1,64}$/;
const SUBAGENT_NAME_RE = /^[a-z0-9-]+$/;
const MODEL_REF_RE = /^[^/\s]+\/\S+$/;

export function validate(d: PersonaConfigView, isNew: boolean, newId: string, taken: boolean, mcpError: string | null): Errors {
  const e: Errors = {};
  if (isNew) {
    if (!newId) e.id = "Choose a file name for the persona.";
    else if (!ID_RE.test(newId)) e.id = "Use lowercase letters, digits and single dashes.";
    else if (taken) e.id = "A persona with this file name already exists.";
  }
  if (!d.name.trim()) e.name = "Name is required.";
  d.folders.forEach((f, i) => {
    if (!f.path.trim()) e[`folder${i}`] = "Enter a folder path on this Mac.";
    else if (f.mount && !/^\/workspace\/[^/]+$/.test(f.mount)) e[`folder${i}`] = "Mount must look like /workspace/<name>.";
  });
  for (const [list, key] of [["networkAllow", "host"], ["networkInternal", "internal"], ["networkOtherCredentials", "other"]] as const)
    (d[list] ?? []).forEach((h, i) => {
      if (!h.trim()) e[`${key}${i}`] = "Enter a host or remove the row.";
      else if (!HOST_RE.test(h.trim())) e[`${key}${i}`] = "Use a hostname, *.domain or host:port.";
    });
  for (const [conn, pc] of Object.entries(d.connections))
    pc.rules.forEach((r, i) => {
      const c = r.credential.trim();
      if (!c) e[`rule-${conn}-${i}`] = "Choose a credential or enter a pattern.";
      else if (!RULE_CREDENTIAL_RE.test(c)) e[`rule-${conn}-${i}`] = "Use a credential name or a pattern with * and ?.";
    });
  const agentNames = new Set<string>();
  d.subagents.agents.forEach((a, i) => {
    const n = a.name.trim();
    const m = a.model.trim();
    if (!n) e[`sa-${i}`] = "Enter a name or remove the row.";
    else if (!SUBAGENT_NAME_RE.test(n) || n.length > 32) e[`sa-${i}`] = "Use lowercase letters, digits and dashes, at most 32.";
    else if (n.startsWith("-")) e[`sa-${i}`] = "Start the name with a letter or digit.";
    else if (n === "auto") e[`sa-${i}`] = "“auto” is reserved. Choose another name.";
    else if (agentNames.has(n)) e[`sa-${i}`] = "Another sub-agent has this name.";
    else if (m !== "auto" && !MODEL_REF_RE.test(m)) e[`sa-${i}`] = "Use provider/model, or auto.";
    agentNames.add(n);
  });
  const bg = d.subagents.maxBackground;
  if (!Number.isInteger(bg) || bg < 0 || bg > 32) e.maxBackground = "Use a whole number from 0 to 32.";
  const turns = d.subagents.maxTurns;
  if (!Number.isInteger(turns) || turns < 1 || turns > 1000) e.maxTurns = "Use a whole number from 1 to 1000.";
  if (!Number.isInteger(d.memory.briefTokens) || d.memory.briefTokens < 0) e.briefTokens = "Use a whole number of tokens.";
  if (mcpError) e.mcp = mcpError;
  return e;
}
