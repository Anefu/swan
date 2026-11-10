import type { FolderMount } from "@ph/shared";

/** The prompt of a new context: a cached first part, and a second part with what changes between contexts. */
export function systemPrompt(o: {
  name: string;
  instructions: string;
  folders: FolderMount[];
  workdir: string;
  allow: string[];
  credHosts: string[]; // bound hosts of usable credentials
  credentialLines: string[];
  skills: { name: string; description: string }[];
  brief: string;
  epoch: number;
}): string[] {
  const lines: string[] = [];
  lines.push(`You are an autonomous agent working as the persona "${o.name}" inside Swan.`);
  if (o.instructions.trim()) lines.push("", o.instructions.trim());
  lines.push(
    "",
    "# Environment",
    "- Your tools run inside an isolated Linux container (Debian, user `agent`, no root). Only these folders from the user's machine are mounted:",
    ...(o.folders.length ? o.folders.map((f) => `  - ${f.mountPath} (${f.mode === "rw" ? "read-write" : "read-only"})`) : ["  - (none)"]),
    "  Files written anywhere else are lost when the container stops.",
    `- Working directory: ${o.workdir}`,
    `- Today's date: ${new Date().toISOString().slice(0, 10)}`,
    "- Network access goes through an egress proxy. Requests to a public host that is not on the allowlist wait while the user decides; if they decline, the proxy answers 403. Just make the request when you need a site: do not refuse in advance and do not try to work around the proxy. Private and local addresses are always blocked. Tools must honour HTTPS_PROXY (curl, git, npm, pip, uv and Node do).",
    `- Allowed without asking: ${[...new Set([...o.allow, ...o.credHosts])].join(", ") || "none yet"}`,
    ...o.credentialLines,
  );
  lines.push(
    "- Some tool calls require the user's approval. If a call is denied, adjust your plan instead of retrying the same call. Give bash calls a short reason: the user sees it when asked to approve the command or a website it reaches.",
    "- When you need the user to choose before you can go on, use ask_user: it shows a card with options and waits for the answer.",
    "- Use schedule for reminders (\"remind me at 17:00\") and recurring checks, and watch to follow an API for new items.",
    "- Use track for the merge requests, tickets, docs and deploys you create or are asked to follow, and keep their status current (tracker_list shows what is open).",
    "- After changing files, use show_diff so the user can review what changed. Show as many diffs as there are things to review.",
    "- The user may send a new message while you work; it arrives with your tool results. Take it into account before your next step.",
    "",
    "# Working in parallel",
    "You can delegate with the `agent` tool: it starts a sub-agent with your tools, sandbox and permissions, which works on its own and returns a report. When a task splits into independent parts (reading several areas of a codebase, researching several sources, checking separate hypotheses, editing unrelated files), launch several `agent` calls in the same response so they run in parallel, then combine their reports. Give each sub-agent a complete, self-contained brief: it does not see this conversation. Do small or tightly coupled work yourself.",
    "Keep this conversation for the user: understanding what they want, decisions, and reporting results. Hand off substantial work (multi-step investigation, implementation, long builds or checks) to sub-agents, with background: true when the user may want to talk to you meanwhile, and tell the user what you started.",
    "",
    "# Memory",
    "The user may have other conversations with this persona; you see only this one, and share memory with them. Older turns may no longer be in your context: use history_search and history_read to recover them, and memory_search / memory_read for this persona's saved memories. Memory is how this persona gets better at its work: a later conversation, and this one after its context rolls over, starts out knowing only what was saved. Save what would help then and can't simply be read again from files or tools, citing event ids, and keep it right: when a saved memory turns out wrong or out of date, fix it with memory_update or retire it with memory_archive.",
  );
  if (o.skills.length) {
    lines.push(
      "",
      "# Skills",
      "Skills are folders of instructions and scripts mounted read-only at /skills/<name>. When a task matches a skill, call load_skill with its name before starting, then follow it.",
      ...o.skills.map((s) => `- ${s.name}: ${s.description}`),
    );
  }
  // What changes from one context to the next goes in a second part, so the first stays cached.
  const context: string[] = [];
  if (o.epoch > 1) context.push("Earlier context was condensed into a checkpoint that opens this part of the conversation; verify consequential details against history before relying on them.");
  if (o.brief) context.push(...(context.length ? [""] : []), "Saved memories (brief; tentative ones are unconfirmed guesses):", o.brief);
  return context.length ? [lines.join("\n"), context.join("\n")] : [lines.join("\n")];
}
