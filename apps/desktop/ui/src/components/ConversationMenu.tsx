import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PendingApproval, SessionSummary } from "@ph/shared";
import { usePendingApprovals, useStore } from "../store";
import { plural, type Tone } from "../status";
import { cls, relTime, useNow } from "../util";
import { IconCheck, IconChevronDown, IconPlus, IconSearch } from "./icons";
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
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("list");
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentId = state.conversations[personaId];
  const current = currentId ? state.sessions[currentId] : undefined;
  const all = useMemo(
    () => Object.values(state.sessions).filter((s) => s.personaId === personaId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [state.sessions, personaId],
  );
  const showSearch = all.length > SEARCH_OVER;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
  }, [all, query]);

  // Rows after the conversations: New, then Fork, Rename and Delete for the one on screen.
  const newIndex = matches.length;
  const forkIndex = newIndex + 1;
  const renameIndex = newIndex + 2;
  const deleteIndex = newIndex + 3;
  const last = current ? deleteIndex : newIndex;

  const close = (refocus = true) => {
    setOpen(false);
    setMode("list");
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  };

  const openMenu = () => {
    setOpen(true);
    setMode("list");
    setActive(Math.max(0, all.findIndex((s) => s.id === currentId)));
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (mode === "rename") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (mode === "list") (inputRef.current ?? listRef.current)?.focus();
  }, [open, mode]);

  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (i: number) => {
    if (i < matches.length) {
      void actions.openConversation(personaId, matches[i]!.id);
      close();
    } else if (i === newIndex) {
      void actions.newConversation(personaId);
      close();
    } else if (i === forkIndex && current) {
      void fork();
    } else if (i === renameIndex && current) {
      setTitle(current.title);
      setMode("rename");
    } else if (i === deleteIndex && current) setMode("delete");
  };

  const fork = async () => {
    if (!current || busy) return;
    setBusy(true);
    const ok = await actions.forkConversation(personaId, current.id);
    setBusy(false);
    if (ok) close();
  };

  const saveTitle = async () => {
    const t = title.trim();
    if (!current || !t || busy) return;
    setBusy(true);
    const ok = await actions.renameConversation(current.id, t);
    setBusy(false);
    if (ok) close();
  };

  const remove = async () => {
    if (!current || busy) return;
    setBusy(true);
    const ok = await actions.deleteConversation(personaId, current.id);
    setBusy(false);
    if (ok) close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (mode === "list") close();
      else setMode("list");
      return;
    }
    if (mode !== "list") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a >= last ? 0 : a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? last : a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(last);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Tab") close(false);
  };

  const action = (i: number, label: string, tone?: string) => (
    <li id={`${listId}-${i}`} role="option" aria-selected={false} className={cls("persona-opt new", tone, active === i && "is-active")} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
      <span className="persona-check" />
      <span className="persona-opt-main">
        <span className="persona-opt-name">{label}</span>
      </span>
    </li>
  );

  return (
    <div ref={rootRef} className="persona-menu conv-menu" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        id="conversation-trigger"
        type="button"
        className={cls("persona-trigger conv-trigger", open && "is-open")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Conversation: ${current?.title ?? "none"}. Switch conversation`}
        onClick={() => (open ? close() : openMenu())}
      >
        <span>{current?.title ?? "New conversation"}</span>
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div className="popover persona-pop">
          {mode === "rename" && (
            <form
              className="conv-rename"
              onSubmit={(e) => {
                e.preventDefault();
                void saveTitle();
              }}
            >
              <label className="field">
                <span className="field-label">Name</span>
                <input ref={inputRef} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
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
                <button type="button" className="btn sm danger" autoFocus onClick={() => void remove()} disabled={busy}>
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
              {showSearch && (
                <label className="search-field">
                  <IconSearch size={16} />
                  <span className="sr-only">Find a conversation</span>
                  <input
                    ref={inputRef}
                    placeholder="Find a conversation"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(0);
                    }}
                    role="combobox"
                    aria-controls={listId}
                    aria-expanded="true"
                    aria-activedescendant={`${listId}-${active}`}
                  />
                </label>
              )}
              <ul ref={listRef} id={listId} role="listbox" aria-label="Conversations" tabIndex={showSearch ? -1 : 0} aria-activedescendant={`${listId}-${active}`} className="persona-list">
                {matches.map((s, i) => {
                  const selected = s.id === currentId;
                  const st = rowStatus(s, approvals, now);
                  return (
                    <li
                      key={s.id}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={selected}
                      className={cls("persona-opt", i === active && "is-active")}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(i)}
                    >
                      <span className="persona-check">{selected && <IconCheck size={16} />}</span>
                      <span className="persona-opt-main">
                        <span className={cls("persona-opt-name conv-opt-name", selected && "strong")} title={s.title}>
                          {s.title}
                        </span>
                      </span>
                      <span className={cls("status-text", `tone-${st.tone}`)}>{st.text}</span>
                    </li>
                  );
                })}
                {matches.length === 0 && <li className="persona-none">No conversation matches “{query}”.</li>}
                <li role="separator" className="sep" aria-hidden="true" />
                <li id={`${listId}-${newIndex}`} role="option" aria-selected={false} className={cls("persona-opt new", active === newIndex && "is-active")} onMouseEnter={() => setActive(newIndex)} onClick={() => choose(newIndex)}>
                  <span className="persona-check">
                    <IconPlus size={16} />
                  </span>
                  <span className="persona-opt-main">
                    <span className="persona-opt-name">New conversation</span>
                  </span>
                  <Kbd>{MOD}N</Kbd>
                </li>
                {current && action(forkIndex, "Fork this conversation")}
                {current && action(renameIndex, "Rename this conversation")}
                {current && action(deleteIndex, "Delete this conversation")}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
