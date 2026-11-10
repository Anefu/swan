// Running the model's tool calls: validation, the persona's permission rules, approval cards and
// questions, and the call's line in the transcript.
import type { ChatItem, ToolCallStatus } from "@ph/shared";
import type { PersonaStore } from "../personas.js";
import type { PodmanRuntime } from "../sandbox/podman.js";
import type { Settings } from "../settings.js";
import type { SkillRegistry } from "../skills.js";
import { errMsg, nowIso, truncateMiddle } from "../util.js";
import type { Approvals } from "./approvals.js";
import { ASK_USER, questionResult, type AskInput } from "./ask-user.js";
import { PermissionPolicy, type Evaluation } from "./permissions.js";
import type { ContentBlockParam, ToolUse } from "./providers.js";
import { permissionView, type ToolContext, type ToolDef, type ToolOutput } from "./tools.js";

type ToolItem = Extract<ChatItem, { kind: "tool_call" }>;

export interface ToolHost {
  id: string;
  personaId: string;
  personas: PersonaStore;
  settings: Settings;
  runtime: PodmanRuntime;
  skills: SkillRegistry;
  approvals: Approvals;
  container(): string;
  workdir(): string;
  /** The conversation's own tool of that name. */
  live(name: string): ToolDef | undefined;
  /** A tool the context names that isn't running: it says so. Never the live tool, so a sub-agent gets only what it was given. */
  unavailable(name: string): ToolDef | undefined;
  addItem(it: ChatItem): void;
  syncItem(it: ChatItem): void;
  notice(level: "info" | "warn" | "error", text: string): void;
  allowances(): string[];
  setAllowances(a: string[]): void;
  /** The latest call, to explain a network request it makes. */
  activity(a: { preview: string; reason?: string }): void;
}

export class ToolRunner {
  constructor(private host: ToolHost) {}

  /** The persona's rules, with what the user allowed "until stopped" or without it. */
  policy(withAllowances = true) {
    const h = this.host;
    const cfg = h.personas.get(h.personaId)?.config;
    return new PermissionPolicy(cfg?.permissions ?? { default: "ask", allow: [], ask: [], deny: [] }, withAllowances ? h.allowances() : []);
  }

  private unattendedPolicy() {
    const h = this.host;
    const allow = h.personas.get(h.personaId)?.config?.unattended.allow ?? [];
    return new PermissionPolicy({ default: "deny", allow, ask: [], deny: [] }, []);
  }

  /** Run calls in parallel; an unattended run refuses what would ask, and never uses allowances. */
  run(toolUses: ToolUse[], signal: AbortSignal, unattended: boolean, parentId?: string, tools?: Map<string, ToolDef>) {
    const policy = this.policy(!unattended);
    return Promise.all(toolUses.map((tu) => this.runOne(tu, policy, signal, unattended, parentId, tools)));
  }

  private ctx(signal: AbortSignal, toolUseId: string): ToolContext {
    const h = this.host;
    return {
      runtime: h.runtime,
      container: h.container(),
      workdir: h.workdir(),
      signal,
      outputLimit: h.settings.toolOutputLimit,
      bashTimeoutMs: h.settings.bashTimeoutMs,
      skills: h.skills,
      personaSkills: h.personas.get(h.personaId)?.config?.skills ?? [],
      toolUseId,
    };
  }

  /**
   * "Allow … until stopped" adds temporary rules: "npm test *" where the card offered it, otherwise
   * the exact command or the tool. "Always allow" saves the offered patterns to the persona; with
   * none on offer it stays temporary.
   */
  private async remember(decision: "allow_session" | "allow_always", perm: Evaluation, tool: ToolDef, input: Record<string, unknown>) {
    const h = this.host;
    const rules = perm.prefixes ? PermissionPolicy.prefixRules(perm.prefixes) : PermissionPolicy.alwaysAllowRules(tool, input);
    if (decision === "allow_always" && perm.prefixes) {
      try {
        await h.personas.addAllowRules(h.personaId, rules);
        return;
      } catch (e) {
        h.notice("error", `Could not save ${perm.prefixes.map((p) => `"${p} *"`).join(", ")} to the persona, so it is allowed until stopped: ${errMsg(e)}`);
      }
    }
    const added = rules.filter((r) => !h.allowances().includes(r));
    if (added.length) h.setAllowances([...h.allowances(), ...added]);
  }

  private async runOne(tu: ToolUse, policy: PermissionPolicy, signal: AbortSignal, unattended: boolean, parentId?: string, tools?: Map<string, ToolDef>): Promise<ContentBlockParam> {
    const h = this.host;
    const tool = (tools ? tools.get(tu.name) : h.live(tu.name)) ?? h.unavailable(tu.name);
    const item: ToolItem = {
      kind: "tool_call",
      id: tu.id,
      ts: nowIso(),
      name: tu.name,
      source: tool?.source ?? (tu.name.startsWith("mcp__") ? "mcp" : "builtin"),
      input: tu.input,
      inputPreview: "",
      status: "running",
      ...(parentId ? { parentId } : {}),
    };
    let added = false;
    const show = () => {
      if (added) h.syncItem(item);
      else {
        added = true;
        h.addItem({ ...item });
      }
    };
    const finish = (status: ToolCallStatus, out: ToolOutput, extra: Partial<ToolItem> = {}): ContentBlockParam => {
      Object.assign(item, extra, { status, output: out.text + (out.images?.length ? `\n[${out.images.length} image(s)]` : ""), isError: !!out.isError }, out.itemPatch);
      show();
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        is_error: out.isError || undefined,
        content: out.images?.length
          ? [{ type: "text", text: out.text }, ...out.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType as "image/png", data: img.data } }))]
          : out.text,
      };
    };
    const decision = (rule: string) => h.approvals.wait(tu.id, { sessionId: h.id, personaId: h.personaId, toolUseId: tu.id, name: tu.name, inputPreview: item.inputPreview, rule, since: nowIso() }, { signal });

    if (!tool) return finish("error", { text: `Unknown tool "${tu.name}".`, isError: true });
    if (tu.invalid !== undefined) return finish("error", { text: JSON.stringify({ INVALID_JSON: tu.invalid }), isError: true });
    const v = tool.validate(tu.input);
    if (!v.ok) return finish("error", { text: `Invalid input: ${v.error}`, isError: true });
    item.inputPreview = tool.preview(v.value);
    const why = (v.value as { reason?: unknown }).reason;
    if (typeof why === "string" && why.trim()) item.reason = why.trim();
    h.activity({ preview: item.inputPreview, reason: item.reason });

    let perm = policy.check(tool, v.value);
    if (perm.mode === "deny") return finish("denied", { text: `Denied by the persona's permission policy (${perm.rule}).`, isError: true }, { denyReason: perm.rule });
    // A question pauses the turn like an approval, and the card is the answer. Sub-agents get a refusal instead.
    if (tool.name === ASK_USER && !parentId) {
      if (unattended) return finish("error", { text: "The user isn't here in an unattended run, so nobody can answer. Choose what you reasonably can, or leave the question in your report.", isError: true });
      item.status = "pending_approval";
      show();
      const d = await decision("question");
      if (!d) return finish("interrupted", { text: "Interrupted by the user before they answered.", isError: true });
      const r = questionResult(v.value as AskInput, d.decision === "deny" ? undefined : d.answer);
      return finish("done", { text: r.text }, { answer: r.answer });
    }
    // Nobody is there to answer in a triggered turn: only what the persona allows unattended goes ahead.
    if (perm.mode === "ask" && unattended) {
      const u = this.unattendedPolicy().evaluate(permissionView(tool), v.value);
      if (u.mode !== "allow") return finish("denied", { text: `Not allowed in an unattended run (${perm.rule}). Don't retry: leave it for the user and say what you would do and why.`, isError: true }, { denyReason: `unattended run: ${perm.rule}` });
      perm = u;
    }
    if (perm.mode === "ask") {
      item.status = "pending_approval";
      item.approvalReason = perm.rule;
      if (perm.uncovered) item.uncoveredCommands = perm.uncovered;
      if (perm.prefixes) item.allowPatterns = perm.prefixes.map((p) => `${p} *`);
      show();
      const d = await decision(perm.rule);
      item.uncoveredCommands = undefined;
      item.allowPatterns = undefined;
      if (!d) return finish("interrupted", { text: "Interrupted by the user before approval.", isError: true });
      if (d.decision === "deny") {
        const reason = d.reason?.trim();
        return finish("denied", { text: `The user denied this tool call${reason ? `: ${reason}` : "."}`, isError: true }, { denyReason: reason || "denied by user" });
      }
      if (d.decision !== "allow") await this.remember(d.decision, perm, permissionView(tool), v.value);
      item.status = "running";
      item.approvalReason = undefined;
    }
    show();

    const started = Date.now();
    let out: ToolOutput;
    try {
      out = await tool.run(v.value, this.ctx(signal, tu.id));
    } catch (e) {
      out = { text: `Tool failed: ${errMsg(e)}`, isError: true };
    }
    const durationMs = Date.now() - started;
    if (signal.aborted) return finish("interrupted", { text: truncateMiddle(`${out.text}\n[interrupted by the user]`, h.settings.toolOutputLimit), isError: true }, { durationMs });
    return finish(out.isError ? "error" : "done", out, { durationMs });
  }
}
