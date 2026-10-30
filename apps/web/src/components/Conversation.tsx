import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ToolItem } from "../receipts";
import { conversationSession, useSelectedPersona, useStore } from "../store";
import { sessionStatusLine } from "../status";
import { cls } from "../util";
import { Composer } from "./Composer";
import { IconWarning } from "./icons";
import { ApprovalCard, AssistantMessage, HarnessReceipt, NoticeLine, Thinking, ToolReceipt, UserMessage } from "./Items";
import { Spinner } from "./ui";

/** Remembered scroll offsets per persona, so switching persona or opening Network activity returns to the same place. */
const scrollMemory = new Map<string, { top: number; atBottom: boolean }>();

export function Conversation({ hidden }: { hidden: boolean }) {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const pid = persona?.id ?? null;
  const session = conversationSession(state, pid);
  const sid = pid ? state.conversations[pid] : undefined;
  const transcript = sid ? state.transcripts[sid] : undefined;
  const items = useMemo(() => transcript?.items ?? [], [transcript]);
  const error = pid ? state.conversationError[pid] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const oldestPendingId = useMemo(() => {
    for (const it of items) if (it.kind === "tool_call" && it.status === "pending_approval") return it.id;
    return null;
  }, [items]);

  // Restore the remembered position when the persona, visibility or transcript changes. Positions are saved on scroll.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pid || hidden) return;
    const mem = scrollMemory.get(pid);
    if (mem && !mem.atBottom) {
      el.scrollTop = mem.top;
      stick.current = false;
    } else {
      el.scrollTop = el.scrollHeight;
      stick.current = true;
    }
  }, [pid, hidden, !!transcript]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow new content when the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current && !hidden) el.scrollTop = el.scrollHeight;
  }, [items, hidden]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (pid && !hidden) scrollMemory.set(pid, { top: el.scrollTop, atBottom: stick.current });
  };

  // "Review" and memory source links.
  const handledApproval = useRef(0);
  useEffect(() => {
    const f = state.focusApproval;
    if (!f || f.seq === handledApproval.current || f.sessionId !== sid || hidden) return;
    const el = document.getElementById(`approval-${f.toolUseId}`);
    if (!el) return; // retried when the transcript arrives
    handledApproval.current = f.seq;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, [state.focusApproval, sid, items, hidden]);

  const handledItem = useRef(0);
  useEffect(() => {
    const f = state.focusItem;
    if (!f || f.seq === handledItem.current || f.sessionId !== sid || hidden) return;
    const el = document.getElementById(`item-${f.itemId}`) ?? document.getElementById(`approval-${f.itemId}`);
    if (!el) return;
    handledItem.current = f.seq;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1600);
  }, [state.focusItem, sid, items, hidden]);

  if (!persona) return null;

  // A fresh conversation has no container yet; "stopped" would only be noise there.
  const status = items.length === 0 && session?.status === "stopped" ? null : sessionStatusLine(session);
  const title = session?.title?.trim() || persona.name;

  let body: React.ReactNode;
  if (error && !transcript) {
    body = (
      <div className="convo-state" role="alert">
        <p>
          <strong>Could not open the conversation.</strong> {error}
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            actions.loadConversation(persona.id);
          }}
        >
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
    let prevKind: string | null = null;
    body = items.map((it) => {
      const showHeader = it.kind === "assistant_text" && prevKind !== "assistant_text" && prevKind !== "thinking";
      prevKind = it.kind;
      switch (it.kind) {
        case "user":
          return <UserMessage key={it.id} item={it} />;
        case "assistant_text":
          return <AssistantMessage key={it.id} item={it} persona={persona} showHeader={showHeader} />;
        case "thinking":
          return <Thinking key={it.id} item={it} />;
        case "notice":
          return <NoticeLine key={it.id} item={it} />;
        case "receipt":
          return <HarnessReceipt key={it.id} item={it} />;
        case "tool_call":
          return it.id === oldestPendingId ? (
            <ApprovalCard key={it.id} item={it as ToolItem} sessionId={sid!} persona={persona} />
          ) : (
            <ToolReceipt key={it.id} item={it as ToolItem} sessionId={sid!} persona={persona} />
          );
      }
    });
  }

  return (
    <div className="convo" hidden={hidden}>
      <div className="convo-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="column">
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
          <div className={cls("items", transcript?.source === "stale" && "is-stale")}>{body}</div>
        </div>
      </div>
      <div className="column composer-wrap">
        {(status || (session && session.queued > 0)) && (
          <div className="session-status" role="status" aria-live="polite">
            {session?.status === "running" || session?.status === "starting" ? <Spinner size={12} /> : null}
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
