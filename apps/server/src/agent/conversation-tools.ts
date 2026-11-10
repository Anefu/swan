import type { SessionSummary } from "@ph/shared";
import { z } from "zod";
import { zodTool, type ToolDef } from "./tools.js";

export const CONVERSATIONS = "conversations";

export interface PersonaRef {
  id: string;
  name: string;
}

/** What the tool needs from the session manager. Only send and list reach another persona. */
export interface ConversationAccess {
  list(personaId: string): SessionSummary[];
  personas(): PersonaRef[];
  rename(id: string, title: string): void;
  remove(id: string): Promise<void>;
  /** Starts an unattended turn in the target, or in a new conversation of the persona. Returns why not, if it can't. */
  deliver(fromId: string, to: { id: string } | { personaId: string }, text: string): Promise<string | null>;
}

const Input = z.object({
  action: z.enum(["list", "send", "rename", "delete"]),
  persona: z.string().optional().describe("list and send: another persona's id or name. send with a persona and no conversation starts a new conversation there"),
  conversation: z.string().optional().describe("Id or exact title. For rename and delete, leave out to mean this conversation"),
  text: z.string().min(1).max(20_000).optional().describe("send: the message"),
  title: z.string().min(1).max(120).optional().describe("rename: the new title"),
});
type Input = z.infer<typeof Input>;

/** Exact id first, then a title that only one conversation has. */
function resolve(all: SessionSummary[], ref: string, where = "this persona"): { id: string } | { error: string } {
  const byId = all.find((s) => s.id === ref);
  if (byId) return { id: byId.id };
  const named = all.filter((s) => s.title === ref);
  if (named.length === 1) return { id: named[0]!.id };
  if (named.length > 1) return { error: `Several conversations are called "${ref}". Use its id: action list shows them.` };
  return { error: `No conversation "${ref}" in ${where}. Action list shows them.` };
}

/** Exact id first, then a name that only one persona has (any case). */
export function resolvePersona(all: PersonaRef[], ref: string): PersonaRef | { error: string } {
  const byId = all.find((p) => p.id === ref);
  if (byId) return byId;
  const named = all.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return { error: `Several personas are called "${ref}". Use its id: ${named.map((p) => p.id).join(", ")}.` };
  return { error: `No persona "${ref}". Personas: ${all.map((p) => `${p.id} (${p.name})`).join(", ") || "none"}.` };
}

/** The persona a call names, when it is another one; null for this persona or none named. */
function otherPersona(input: { persona?: unknown }, personaId: string, personas: PersonaRef[]): PersonaRef | { error: string } | null {
  if (typeof input.persona !== "string" || !input.persona.trim()) return null;
  const p = resolvePersona(personas, input.persona.trim());
  return "id" in p && p.id === personaId ? null : p;
}

/**
 * Changing a conversation the user started asks first, so an unattended run can't: only its own
 * title, and run conversations, are free to change. Sending to another persona asks too: its agent
 * has its own folders, credentials and permissions, which this one shouldn't reach unseen.
 */
export function conversationAsks(input: { action?: unknown; conversation?: unknown; persona?: unknown }, ctx: { selfId: string; personaId: string; all: SessionSummary[]; personas: PersonaRef[] }): boolean {
  if (input.action === "send") return otherPersona(input, ctx.personaId, ctx.personas) !== null;
  if (input.action !== "rename" && input.action !== "delete") return false;
  const ref = typeof input.conversation === "string" ? input.conversation : ctx.selfId;
  const found = resolve(ctx.all, ref);
  if ("error" in found) return false; // the tool reports it
  const target = ctx.all.find((s) => s.id === found.id);
  if (target?.trigger) return false;
  return input.action === "delete" || found.id !== ctx.selfId;
}

const line = (s: SessionSummary, selfId: string) => `- ${s.id}${s.id === selfId ? " (this one)" : ""}: ${JSON.stringify(s.title)} · ${s.status} · updated ${s.updatedAt}${s.trigger ? ` · run of ${s.trigger}` : ""}`;

export function conversationTools(o: {
  access: ConversationAccess;
  personaId: string;
  selfId: string;
  canSend: () => boolean;
  deleteSelfWhenDone: () => void;
}): ToolDef[] {
  const { access, personaId, selfId } = o;
  const all = (pid = personaId) => access.list(pid);
  return [
    zodTool({
      name: CONVERSATIONS,
      description: [
        "Manage this persona's conversations and message other ones. Each run of a schedule or watcher has its own, so use this to pass a result on and to tidy up.",
        "list shows this persona's conversations, or another persona's with persona. send gives a conversation a message and starts a turn there: it is told the message came from this tool, not the user, and that turn runs unattended, so anything needing approval is refused. A turn started by send can't send further.",
        "To reach another persona, give persona (its id or name): with a conversation it goes there, without one it starts a new conversation in that persona. Sending to another persona asks the user first.",
        "rename and delete act on one conversation of this persona. A run that found nothing worth keeping should delete itself as its last step: it goes when the turn ends. Changing a conversation the user started asks them first, except renaming the one you are in.",
        "To have a result come back here, give this conversation's id (from list) in the message or in the schedule's or watcher's prompt.",
      ].join(" "),
      schema: Input,
      preview: (i: Input) =>
        i.action === "list"
          ? `list conversations${i.persona ? ` of ${i.persona}` : ""}`
          : `${i.action} ${i.persona ? `${i.persona} · ` : ""}${i.conversation ?? (i.persona && i.action === "send" ? "a new conversation" : "this conversation")}${i.title ? ` · ${i.title}` : ""}`,
      primaryArg: (i: Input) => i.action,
      async run(i: Input) {
        const other = otherPersona(i, personaId, access.personas());
        if (other && "error" in other) return { text: other.error, isError: true };
        if (i.action === "list") {
          const list = all(other?.id).map((s) => line(s, selfId));
          return { text: list.join("\n") || `${other ? other.name : "This persona"} has no conversations.` };
        }
        if (other && i.action !== "send") return { text: "rename and delete work on this persona's conversations only.", isError: true };
        if (i.action === "send") {
          if (!o.canSend()) return { text: "This turn was started by a message from another conversation, so it can't send further. Say what you found here.", isError: true };
          if (!i.text) return { text: "Give the text to send.", isError: true };
          if (!i.conversation && !other) return { text: "Give the conversation to send to, or a persona to start a new conversation in.", isError: true };
          let to: { id: string } | { personaId: string };
          if (i.conversation) {
            const found = resolve(all(other?.id), i.conversation, other ? `persona ${other.name}` : "this persona");
            if ("error" in found) return { text: found.error, isError: true };
            if (found.id === selfId) return { text: "That's this conversation: nothing to send.", isError: true };
            to = found;
          } else to = { personaId: other!.id };
          const refused = await access.deliver(selfId, to, i.text);
          return refused ? { text: refused, isError: true } : { text: "id" in to ? "Sent. A turn starts there once it is free." : `Sent. It starts a new conversation in ${other!.name}.` };
        }
        const found = resolve(all(), i.conversation ?? selfId);
        if ("error" in found) return { text: found.error, isError: true };
        const self = found.id === selfId;
        if (i.action === "rename") {
          if (!i.title) return { text: "Give the new title.", isError: true };
          access.rename(found.id, i.title.replace(/\s+/g, " ").trim());
          return { text: "Renamed." };
        }
        if (self) {
          o.deleteSelfWhenDone();
          return { text: "This conversation will be deleted when this turn ends." };
        }
        await access.remove(found.id);
        return { text: "Deleted." };
      },
    }),
  ];
}
