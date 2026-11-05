import type { SessionSummary } from "@ph/shared";
import { z } from "zod";
import { zodTool, type ToolDef } from "./tools.js";

export const CONVERSATIONS = "conversations";

/** What the tool needs from the session manager. Every call stays inside one persona. */
export interface ConversationAccess {
  list(personaId: string): SessionSummary[];
  rename(id: string, title: string): void;
  remove(id: string): Promise<void>;
  /** Starts an unattended turn in the target. Returns why not, if it can't. */
  deliver(fromId: string, toId: string, text: string): Promise<string | null>;
}

const Input = z.object({
  action: z.enum(["list", "send", "rename", "delete"]),
  conversation: z.string().optional().describe("Id or exact title. For rename and delete, leave out to mean this conversation"),
  text: z.string().min(1).max(20_000).optional().describe("send: the message"),
  title: z.string().min(1).max(120).optional().describe("rename: the new title"),
});
type Input = z.infer<typeof Input>;

/** Exact id first, then a title that only one conversation has. */
function resolve(all: SessionSummary[], ref: string): { id: string } | { error: string } {
  const byId = all.find((s) => s.id === ref);
  if (byId) return { id: byId.id };
  const named = all.filter((s) => s.title === ref);
  if (named.length === 1) return { id: named[0]!.id };
  if (named.length > 1) return { error: `Several conversations are called "${ref}". Use its id: action list shows them.` };
  return { error: `No conversation "${ref}" in this persona. Action list shows them.` };
}

/**
 * Changing a conversation the user started asks first, so an unattended run can't: only its own
 * title, and run conversations, are free to change.
 */
export function conversationAsks(input: { action?: unknown; conversation?: unknown }, selfId: string, all: SessionSummary[]): boolean {
  if (input.action !== "rename" && input.action !== "delete") return false;
  const ref = typeof input.conversation === "string" ? input.conversation : selfId;
  const found = resolve(all, ref);
  if ("error" in found) return false; // the tool reports it
  const target = all.find((s) => s.id === found.id);
  if (target?.trigger) return false;
  return input.action === "delete" || found.id !== selfId;
}

export function conversationTools(o: {
  access: ConversationAccess;
  personaId: string;
  selfId: string;
  canSend: () => boolean;
  deleteSelfWhenDone: () => void;
}): ToolDef[] {
  const { access, personaId, selfId } = o;
  const all = () => access.list(personaId);
  return [
    zodTool({
      name: CONVERSATIONS,
      description: [
        "Manage this persona's conversations. Each run of a schedule or watcher has its own, so use this to pass a result on and to tidy up.",
        "list shows them. send gives another conversation a message and starts a turn there: it is told the message came from this tool, not the user, and that turn runs unattended, so anything needing approval is refused. A turn started by send can't send further.",
        "rename and delete act on one conversation. A run that found nothing worth keeping should delete itself as its last step: it goes when the turn ends. Changing a conversation the user started asks them first, except renaming the one you are in.",
        "To have a result come back here, put this conversation's id (from list) in the schedule's or watcher's prompt.",
      ].join(" "),
      schema: Input,
      preview: (i: Input) => (i.action === "list" ? "list conversations" : `${i.action} ${i.conversation ?? "this conversation"}${i.title ? ` · ${i.title}` : ""}`),
      primaryArg: (i: Input) => i.action,
      async run(i: Input) {
        if (i.action === "list") {
          return {
            text: all()
              .map((s) => `- ${s.id}${s.id === selfId ? " (this one)" : ""}: ${JSON.stringify(s.title)} · ${s.status} · updated ${s.updatedAt}${s.trigger ? ` · run of ${s.trigger}` : ""}`)
              .join("\n"),
          };
        }
        if (i.action === "send" && !o.canSend()) return { text: "This turn was started by a message from another conversation, so it can't send further. Say what you found here.", isError: true };
        if (i.action === "send" && !i.conversation) return { text: "Give the conversation to send to.", isError: true };
        const found = resolve(all(), i.conversation ?? selfId);
        if ("error" in found) return { text: found.error, isError: true };
        const self = found.id === selfId;
        if (i.action === "send") {
          if (self) return { text: "That's this conversation: nothing to send.", isError: true };
          if (!i.text) return { text: "Give the text to send.", isError: true };
          const refused = await access.deliver(selfId, found.id, i.text);
          return refused ? { text: refused, isError: true } : { text: "Sent. A turn starts there once it is free." };
        }
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
