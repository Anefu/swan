import { useEffect, useMemo, useRef, useState } from "react";
import type { PendingApproval, SessionSummary } from "@ph/shared";
import { usePendingApprovals, useStore } from "../store";
import { plural, type Tone } from "../status";
import { cls, relTime, useNow } from "../util";
import { IconCheck, IconChevronDown, IconPlus } from "./icons";
import { MenuList, MenuOption, MenuSearch, useListMenu } from "./ListMenu";
import { Kbd, MOD } from "./ui";

const SEARCH_OVER = 8;
type Mode = "list" | "rename" | "delete";

function rowStatus(s: SessionSummary, approvals: PendingApproval[], now: number): { text: string; tone: Tone } {
  const waiting = approvals.filter((a) => a.sessionId === s.id).length;
  if (waiting > 0) return { text: plural(waiting, "decision"), tone: "attention" };
  if (s.status === "running") return { text: "Working", tone: "ok" };
  if (s.status === "starting") return { text: "Starting", tone: "muted" };
  if (s.status === "error") return { text: "Error", tone: "error" };
  return { text: relTime(s.updatedAt, now), tone: "muted" };
}

/** The persona's conversations, newest first: switch, start, fork, rename or delete. */
export function ConversationMenu({ personaId }: { personaId: string }) {
  const { state, actions } = useStore();
  const approvals = usePendingApprovals();
  const now = useNow();
  const [mode, setMode] = useState<Mode>("list");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

  const currentId = state.conversations[personaId];
  const current = currentId ? state.sessions[currentId] : undefined;
  const all = useMemo(
    () => Object.values(state.sessions).filter((s) => s.personaId === personaId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [state.sessions, personaId],
  );
  const showSearch = all.length > SEARCH_OVER;
  const menu = useListMenu({ count: () => (current ? deleteIndex : newIndex) + 1, choose: (i) => choose(i), navigating: mode === "list", back: () => setMode("list") });
  const matches = useMemo(() => {
    const q = menu.query.trim().toLowerCase();
    return q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
  }, [all, menu.query]);

  // Rows after the conversations: New, then Fork, Rename and Delete for the one on screen.
  const newIndex = matches.length;
  const forkIndex = newIndex + 1;
  const renameIndex = newIndex + 2;
  const deleteIndex = newIndex + 3;

  const close = (refocus = true) => {
    menu.close(refocus);
    setMode("list");
  };
  const openMenu = () => {
    setMode("list");
    menu.openAt(all.findIndex((s) => s.id === currentId));
  };

  useEffect(() => {
    if (menu.open && mode === "rename") {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [menu.open, mode]);

  const choose = (i: number) => {
    if (i < matches.length) {
      void actions.openConversation(personaId, matches[i]!.id);
      close();
    } else if (i === newIndex) {
      void actions.newConversation(personaId);
      close();
    } else if (i === forkIndex && current) {
      void run(() => actions.forkConversation(personaId, current.id));
    } else if (i === renameIndex && current) {
      setTitle(current.title);
      setMode("rename");
    } else if (i === deleteIndex && current) setMode("delete");
  };

  /** One change to the conversation on screen; the menu closes when it worked. */
  const run = async (change: () => Promise<boolean>) => {
    if (!current || busy) return;
    setBusy(true);
    const ok = await change();
    setBusy(false);
    if (ok) close();
  };

  const action = (i: number, label: string) => (
    <MenuOption menu={menu} index={i} onChoose={choose} className="new">
      <span className="persona-opt-name">{label}</span>
    </MenuOption>
  );

  return (
    <div ref={menu.rootRef} className="persona-menu conv-menu" onKeyDown={menu.onKeyDown}>
      <button
        ref={menu.triggerRef}
        id="conversation-trigger"
        type="button"
        className={cls("persona-trigger conv-trigger", menu.open && "is-open")}
        aria-haspopup="listbox"
        aria-expanded={menu.open}
        aria-label={`Conversation: ${current?.title ?? "none"}. Switch conversation`}
        onClick={() => (menu.open ? close() : openMenu())}
      >
        <span>{current?.title ?? "New conversation"}</span>
        <IconChevronDown size={14} />
      </button>
      {menu.open && (
        <div className="popover persona-pop">
          {mode === "rename" && current && (
            <form
              className="conv-rename"
              onSubmit={(e) => {
                e.preventDefault();
                const t = title.trim();
                if (t) void run(() => actions.renameConversation(current.id, t));
              }}
            >
              <label className="field">
                <span className="field-label">Name</span>
                <input ref={renameRef} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <div className="row gap end">
                <button type="submit" className="btn sm primary" disabled={busy || !title.trim()}>
                  Save
                </button>
                <button type="button" className="btn sm" onClick={() => setMode("list")} disabled={busy}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {mode === "delete" && current && (
            <div className="conv-rename" role="alertdialog" aria-label="Delete this conversation">
              <p className="small">
                Delete “{current.title}”? Its messages and files go with it, and anything it's running stops. The persona's memory stays.
              </p>
              <div className="row gap end">
                <button type="button" className="btn sm danger" autoFocus onClick={() => void run(() => actions.deleteConversation(personaId, current.id))} disabled={busy}>
                  Delete
                </button>
                <button type="button" className="btn sm" onClick={() => setMode("list")} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {mode === "list" && (
            <>
              {showSearch && <MenuSearch menu={menu} label="Find a conversation" />}
              <MenuList menu={menu} label="Conversations" searching={showSearch}>
                {matches.map((s, i) => {
                  const selected = s.id === currentId;
                  const st = rowStatus(s, approvals, now);
                  return (
                    <MenuOption
                      key={s.id}
                      menu={menu}
                      index={i}
                      onChoose={choose}
                      selected={selected}
                      mark={selected && <IconCheck size={16} />}
                      aside={<span className={cls("status-text", `tone-${st.tone}`)}>{st.text}</span>}
                    >
                      <span className={cls("persona-opt-name conv-opt-name", selected && "strong")} title={s.title}>
                        {s.title}
                      </span>
                    </MenuOption>
                  );
                })}
                {matches.length === 0 && <li className="persona-none">No conversation matches “{menu.query}”.</li>}
                <li role="separator" className="sep" aria-hidden="true" />
                <MenuOption menu={menu} index={newIndex} onChoose={choose} className="new" mark={<IconPlus size={16} />} aside={<Kbd>{MOD}N</Kbd>}>
                  <span className="persona-opt-name">New conversation</span>
                </MenuOption>
                {current && action(forkIndex, "Fork this conversation")}
                {current && action(renameIndex, "Rename this conversation")}
                {current && action(deleteIndex, "Delete this conversation")}
              </MenuList>
            </>
          )}
        </div>
      )}
    </div>
  );
}
