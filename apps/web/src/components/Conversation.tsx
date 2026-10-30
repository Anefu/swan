import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatItem, SessionSummary } from "@ph/shared";
import { describeTool, type ToolItem } from "../receipts";
import { conversationSession, useSelectedPersona, useStore } from "../store";
import { sessionStatusLine } from "../status";
import { cls, useNow } from "../util";
import { Composer } from "./Composer";
import { IconArrowRight, IconWarning } from "./icons";
import { AgentLine, AssistantText, Dots, HarnessReceipt, NoticeLine, Thinking, ToolGroup, ToolLine, UserMessage } from "./Items";
import { Spinner } from "./ui";

/** Remembered scroll offsets per persona. */
const scrollMemory = new Map<string, { top: number; atBottom: boolean }>();

const PROGRESSIVE: Record<string, string> = {
  Ran: "Running",
  Read: "Reading",
  Searched: "Searching",
  Edited: "Editing",
  Wrote: "Writing",
  Called: "Calling",
  "Loaded skill": "Loading skill",
};

const FINISHED = new Set(["done", "error", "denied", "interrupted"]);

export function Conversation() {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const pid = persona?.id ?? null;
  const session = conversationSession(state, pid);
  const sid = pid ? state.conversations[pid] : undefined;
  const transcript = sid ? state.transcripts[sid] : undefined;
  const items = useMemo(() => transcript?.items ?? [], [transcript]);
  const error = pid ? state.conversationError[pid] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const oldestPendingId = useMemo(() => {
    for (const it of items) if (it.kind === "tool_call" && it.status === "pending_approval") return it.id;
    return null;
  }, [items]);

  // Restore the remembered position on persona switch or first load. Positions are saved on scroll.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pid) return;
    const mem = scrollMemory.get(pid);
    if (mem && !mem.atBottom) {
      el.scrollTop = mem.top;
      stick.current = false;
      setAtBottom(false);
    } else {
      el.scrollTop = el.scrollHeight;
      stick.current = true;
      setAtBottom(true);
    }
  }, [pid, !!transcript]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stay pinned to the bottom while the reader is there, including when content grows in place (streaming, expanding).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  useEffect(() => {
    const el = scrollRef.current;
    const inner = contentRef.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    if (pid) scrollMemory.set(pid, { top: el.scrollTop, atBottom: bottom });
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // "Review" and memory source links.
  const handledApproval = useRef(0);
  useEffect(() => {
    const f = state.focusApproval;
    if (!f || f.seq === handledApproval.current || f.sessionId !== sid) return;
    const el = document.getElementById(`approval-${f.toolUseId}`) ?? document.getElementById(`item-${f.toolUseId}`);
    if (!el) return; // retried when the transcript arrives
    handledApproval.current = f.seq;
    stick.current = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, [state.focusApproval, sid, items]);

  const handledItem = useRef(0);
  useEffect(() => {
    const f = state.focusItem;
    if (!f || f.seq === handledItem.current || f.sessionId !== sid) return;
    const el = document.getElementById(`item-${f.itemId}`);
    if (!el) return;
    handledItem.current = f.seq;
    stick.current = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1600);
  }, [state.focusItem, sid, items]);

  if (!persona) return null;

  // Working, streaming and approvals are shown in the transcript; the line above the composer is for other states.
  const statusRaw = items.length === 0 && session?.status === "stopped" ? null : sessionStatusLine(session);
  const status = session?.status === "running" || session?.status === "starting" ? null : statusRaw;
  const title = session?.title?.trim() || persona.name;

  let body: ReactNode;
  if (error && !transcript) {
    body = (
      <div className="convo-state" role="alert">
        <p>
          <strong>Could not open the conversation.</strong> {error}
        </p>
        <button type="button" className="btn" onClick={() => void actions.loadConversation(persona.id)}>
          Try again
        </button>
      </div>
    );
  } else if (!transcript) {
    body = (
      <div className="convo-state">
        <Spinner size={14} /> Opening the conversation…
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="convo-state">
        <p>Nothing here yet. Tell {persona.name} what to work on.</p>
        <p className="muted">
          Type <span className="mono">/</span> for commands. Credentials stay placeholders inside the sandbox.
        </p>
      </div>
    );
  } else {
    body = renderItems(items, sid!, persona, oldestPendingId);
  }

  return (
    <div
      className="convo"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) actions.addAttachments(persona.id, files);
      }}
    >
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop files to attach them to your next message</span>
        </div>
      )}
      <div className="convo-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="column" ref={contentRef}>
          <h1 className="convo-title">{title}</h1>
          {persona.errors.length > 0 && (
            <div className="line-banner warn" role="status">
              <IconWarning size={16} />
              <span>
                <strong>This persona cannot start:</strong> {persona.errors[0]}
                {persona.errors.length > 1 && ` (and ${persona.errors.length - 1} more)`}
              </span>
              <button type="button" className="btn sm" onClick={() => actions.openSettings("persona")}>
                Open Settings
              </button>
            </div>
          )}
          {persona.missingCredentials.length > 0 && (
            <div className="line-banner warn" role="status">
              <IconWarning size={16} />
              <span>
                Missing credential{persona.missingCredentials.length > 1 ? "s" : ""}:{" "}
                <span className="mono">{persona.missingCredentials.join(", ")}</span>. Requests that need{" "}
                {persona.missingCredentials.length > 1 ? "them" : "it"} will fail.
              </span>
              <button type="button" className="btn sm" onClick={() => actions.openSettings("swan")}>
                Add value
              </button>
            </div>
          )}
          <div className={cls("items", transcript?.source === "stale" && "is-stale")}>
            {body}
            <WorkingLine session={session} items={items} />
          </div>
        </div>
      </div>
      <div className="column composer-wrap">
        {!atBottom && (
          <button type="button" className="jump-latest" onClick={jumpToLatest}>
            Jump to latest <IconArrowRight size={13} className="rot90" />
          </button>
        )}
        {(status || (session && session.queued > 0)) && (
          <div className="session-status" role="status" aria-live="polite">
            {status && <span className={`tone-${status.tone}`}>{status.text}</span>}
            {session && session.queued > 0 && (
              <span className="muted">
                {status ? " · " : ""}
                {session.queued === 1 ? "1 message will steer the next step" : `${session.queued} messages will steer the next step`}
              </span>
            )}
          </div>
        )}
        <Composer persona={persona} session={session} sessionId={sid ?? null} />
      </div>
    </div>
  );
}

function renderItems(all: ChatItem[], sid: string, persona: Parameters<typeof ToolLine>[0]["persona"], oldestPendingId: string | null) {
  // Sub-agent calls (parentId) leave the main flow and render under their agent line.
  const childrenOf = new Map<string, ToolItem[]>();
  const items: ChatItem[] = [];
  for (const it of all) {
    if (it.kind === "tool_call" && it.parentId) {
      const list = childrenOf.get(it.parentId) ?? [];
      list.push(it as ToolItem);
      childrenOf.set(it.parentId, list);
    } else items.push(it);
  }
  const out: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === "tool_call") {
      const run: ToolItem[] = [];
      while (i < items.length && items[i].kind === "tool_call") run.push(items[i++] as ToolItem);
      const settled = (t: ToolItem) =>
        FINISHED.has(t.status) && !(childrenOf.get(t.id) ?? []).some((c) => !FINISHED.has(c.status));
      if (run.length >= 2 && run.every(settled)) {
        out.push(<ToolGroup key={`g-${run[0].id}`} items={run} sessionId={sid} persona={persona} childrenOf={childrenOf} />);
      } else {
        for (const t of run)
          out.push(
            t.name === "agent" ? (
              <AgentLine
                key={t.id}
                item={t}
                sessionId={sid}
                persona={persona}
                subItems={childrenOf.get(t.id) ?? []}
                oldestPendingId={oldestPendingId}
              />
            ) : (
              <ToolLine key={t.id} item={t} sessionId={sid} persona={persona} promptOpen={t.id === oldestPendingId} />
            ),
          );
      }
      continue;
    }
    const next = items[i + 1];
    switch (it.kind) {
      case "user":
        out.push(<UserMessage key={it.id} item={it} sessionId={sid} />);
        break;
      case "assistant_text":
        out.push(<AssistantText key={it.id} item={it} />);
        break;
      case "thinking":
        out.push(<Thinking key={it.id} item={it} endTs={next?.ts ?? null} />);
        break;
      case "notice":
        out.push(<NoticeLine key={it.id} item={it} />);
        break;
      case "receipt":
        out.push(<HarnessReceipt key={it.id} item={it} />);
        break;
    }
    i++;
  }
  return out;
}

/** One muted line while the model works and nothing streams: "Working… 14s" or "Running npm test…". */
function WorkingLine({ session, items }: { session: SessionSummary | null; items: ChatItem[] }) {
  const now = useNow(1000);
  if (!session || (session.status !== "running" && session.status !== "starting")) return null;
  const last = items[items.length - 1];
  if (last && (last.kind === "assistant_text" || last.kind === "thinking") && last.streaming) return null;
  let text = session.status === "starting" ? session.statusDetail || "Starting the sandbox" : "Working";
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool_call" && it.status === "running") {
      const d = describeTool(it);
      text = `${PROGRESSIVE[d.verb] ?? "Running"} ${d.target}`;
      break;
    }
    if (it.kind === "user") break;
  }
  let since: string | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user") {
      since = items[i].ts;
      break;
    }
  }
  const secs = since ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : null;
  return (
    <div className="working" role="status" aria-live="off">
      <span className="glyph tone-accent working-glyph" aria-hidden="true">
        ✻
      </span>
      <span className="shimmer working-text">
        {text}
        <Dots />
      </span>
      {secs !== null && <span className="line-meta">{secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}</span>}
      <span className="line-meta">· {navigator.platform.includes("Mac") ? "⌘." : "Ctrl+."} to stop</span>
    </div>
  );
}
