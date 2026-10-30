import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatItem, PersonaSummary, SessionSummary } from "@ph/shared";
import { sessionsForPersona, useSelectedPersona, useSelectedSession, useStore } from "../store";
import { cls, fmtTokens, fullTime, isBusy, SESSION_STATUS_LABEL } from "../util";
import {
  IconAlert,
  IconArrowUp,
  IconChevronRight,
  IconInfo,
  IconMessage,
  IconPanelRight,
  IconPlus,
  IconPower,
  IconShield,
  IconStop,
  IconTrash,
  IconWarning,
} from "./icons";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import { ConfirmDialog, EmptyState, Kbd, Spinner, StatusDot } from "./ui";

export function ChatView() {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const session = useSelectedSession();

  if (!persona) {
    return (
      <div className="pane-center">
        {state.personas.length === 0 ? (
          <EmptyState
            icon={<IconMessage size={28} />}
            title="Create your first persona"
            actions={
              <button type="button" className="btn primary" onClick={() => actions.openDialog({ kind: "new-persona" })}>
                <IconPlus /> New persona
              </button>
            }
          >
            A persona bundles the folders, skills, MCP servers, credentials and permissions an agent works with.
          </EmptyState>
        ) : (
          <EmptyState icon={<IconMessage size={28} />} title="Select a persona">
            Pick a persona in the sidebar to see its sessions.
          </EmptyState>
        )}
      </div>
    );
  }
  if (!session || session.personaId !== persona.id) return <PersonaHome persona={persona} />;
  return <SessionView key={session.id} session={session} persona={persona} />;
}

function PanelToggle() {
  const { state, actions } = useStore();
  return (
    <button
      type="button"
      className={cls("icon-btn", state.ui.rightOpen && "on")}
      title="Toggle side panel (Ctrl+\\)"
      aria-label="Toggle side panel"
      aria-pressed={state.ui.rightOpen}
      onClick={() => actions.setUi({ rightOpen: !state.ui.rightOpen })}
    >
      <IconPanelRight />
    </button>
  );
}

function PersonaHome({ persona }: { persona: PersonaSummary }) {
  const { state, actions } = useStore();
  const sessions = sessionsForPersona(state, persona.id);
  const [creating, setCreating] = useState(false);
  const blocked = persona.errors.length > 0;

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <h2>{persona.name || persona.id}</h2>
          <span className="muted mono">{persona.id}</span>
        </div>
        <div className="chat-meta">
          <PanelToggle />
        </div>
      </header>
      <div className="pane-center">
        <EmptyState
          icon={<IconMessage size={28} />}
          title={sessions.length ? "No session selected" : "No sessions yet"}
          actions={
            <button
              type="button"
              className="btn primary"
              disabled={blocked || creating}
              onClick={async () => {
                setCreating(true);
                await actions.createSession(persona.id);
                setCreating(false);
              }}
            >
              {creating ? <Spinner /> : <IconPlus />} New session
            </button>
          }
        >
          {persona.description && <p>{persona.description}</p>}
          <p className="muted">
            <span className="mono">
              {persona.model.provider}/{persona.model.id}
            </span>
            {persona.model.effort && <> · effort {persona.model.effort}</>} · {persona.folders.length} folder
            {persona.folders.length === 1 ? "" : "s"} · {persona.skills.length} skill{persona.skills.length === 1 ? "" : "s"} ·{" "}
            {persona.mcpServers.length} MCP server{persona.mcpServers.length === 1 ? "" : "s"}
          </p>
          {sessions.length > 0 && <p className="muted">Pick a session in the sidebar or start a new one.</p>}
          {blocked && (
            <div className="notice notice-error left">
              <IconAlert />
              <div>
                <strong>This persona has configuration errors and cannot start sessions.</strong>
                <ul>
                  {persona.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
                <button type="button" className="link-btn" onClick={() => actions.openRightTab("persona")}>
                  Edit persona
                </button>
              </div>
            </div>
          )}
          {persona.missingCredentials.length > 0 && (
            <div className="notice notice-warn left">
              <IconWarning />
              <div>
                Missing credentials: <span className="mono">{persona.missingCredentials.join(", ")}</span>.{" "}
                <button type="button" className="link-btn" onClick={() => actions.showView("credentials")}>
                  Set them
                </button>
              </div>
            </div>
          )}
        </EmptyState>
      </div>
    </div>
  );
}

function SessionView({ session, persona }: { session: SessionSummary; persona: PersonaSummary }) {
  const { state } = useStore();
  const transcript = state.transcripts[session.id];
  const items = transcript?.items ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Follow the bottom while new output arrives, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const pending = items.filter(
    (i): i is Extract<ChatItem, { kind: "tool_call" }> => i.kind === "tool_call" && i.status === "pending_approval",
  );
  const last = items[items.length - 1];
  const lastActive =
    last &&
    (((last.kind === "assistant_text" || last.kind === "thinking") && last.streaming) ||
      (last.kind === "tool_call" && (last.status === "running" || last.status === "pending_approval")));
  const working = session.status === "running" && !lastActive;

  return (
    <div className="chat">
      <ChatHeader session={session} />
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-items">
          {!transcript && (
            <div className="chat-loading">
              <Spinner /> Loading transcript…
            </div>
          )}
          {transcript && items.length === 0 && (
            <div className="chat-hello">
              <h3>{persona.name}</h3>
              <p className="muted">
                {session.status === "starting"
                  ? "Starting the sandbox…"
                  : "Send a message to start. The agent works inside the sandbox with this persona's folders and tools."}
              </p>
            </div>
          )}
          {items.map((item) => (
            <ChatItemView key={item.id} item={item} sessionId={session.id} />
          ))}
          {working && (
            <div className="working" aria-live="polite">
              <span className="working-dots">
                <span />
                <span />
                <span />
              </span>
              {session.statusDetail || "Working"}
            </div>
          )}
        </div>
      </div>
      {pending.length > 0 && <PendingBar count={pending.length} firstId={pending[0].id} />}
      <Composer session={session} persona={persona} />
    </div>
  );
}

const ChatItemView = memo(function ChatItemView({ item, sessionId }: { item: ChatItem; sessionId: string }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-user">
          <div className="msg-user-body" title={fullTime(item.ts)}>
            {item.text}
          </div>
        </div>
      );
    case "assistant_text":
      return (
        <div className="msg-assistant">
          <Markdown text={item.text} streaming={item.streaming} />
        </div>
      );
    case "thinking":
      return <Thinking text={item.text} streaming={item.streaming} />;
    case "tool_call":
      return <ToolCard item={item} sessionId={sessionId} />;
    case "notice":
      return (
        <div className={cls("notice", `notice-${item.level}`)} role={item.level === "error" ? "alert" : undefined}>
          {item.level === "info" ? <IconInfo /> : item.level === "warn" ? <IconWarning /> : <IconAlert />}
          <span className="notice-text">{item.text}</span>
        </div>
      );
  }
});

function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cls("thinking", open && "open")}>
      <button type="button" className="thinking-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <IconChevronRight className={cls("chev", open && "open")} />
        {streaming ? "Thinking…" : "Thought"}
        {!open && text && <span className="thinking-peek">{text.slice(-140).replace(/\s+/g, " ")}</span>}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function ChatHeader({ session }: { session: SessionSummary }) {
  const { actions } = useStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const u = session.usage;
  return (
    <header className="chat-head">
      <div className="chat-title">
        <StatusDot status={session.status} />
        <h2 title={session.title}>{session.title || "Untitled session"}</h2>
        <span className={cls("chip", `ss-${session.status}`)}>{SESSION_STATUS_LABEL[session.status]}</span>
        {session.statusDetail && (
          <span className="status-detail" title={session.statusDetail}>
            {session.statusDetail}
          </span>
        )}
      </div>
      <div className="chat-meta">
        <span className="meta-model mono" title={`${session.model.provider}/${session.model.id}`}>
          {session.model.id}
        </span>
        <span
          className="meta-usage"
          title={`Input ${u.inputTokens.toLocaleString()} · Output ${u.outputTokens.toLocaleString()} · Cache read ${u.cacheReadTokens.toLocaleString()} · Cache write ${u.cacheWriteTokens.toLocaleString()} tokens`}
        >
          <span>
            in <b>{fmtTokens(u.inputTokens)}</b>
          </span>
          <span>
            out <b>{fmtTokens(u.outputTokens)}</b>
          </span>
          <span>
            cache <b>{fmtTokens(u.cacheReadTokens)}</b>
          </span>
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Stop sandbox (removes the container, keeps the transcript)"
          aria-label="Stop sandbox"
          disabled={session.status === "stopped"}
          onClick={() => void actions.stopSession(session.id)}
        >
          <IconPower />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Delete session"
          aria-label="Delete session"
          onClick={() => setConfirmDelete(true)}
        >
          <IconTrash />
        </button>
        <PanelToggle />
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete session?"
          confirmLabel="Delete session"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            if (await actions.deleteSession(session.id)) setConfirmDelete(false);
          }}
        >
          <p>
            “{session.title || "Untitled session"}” and its transcript will be deleted permanently. Files the agent changed
            in mounted folders are not affected.
          </p>
        </ConfirmDialog>
      )}
    </header>
  );
}

function PendingBar({ count, firstId }: { count: number; firstId: string }) {
  const jump = () => {
    const el = document.getElementById(`tool-${firstId}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.querySelector<HTMLButtonElement>("[data-approve-first]")?.focus({ preventScroll: true });
  };
  return (
    <div className="pending-bar" role="status">
      <IconShield />
      <span>
        {count} tool call{count === 1 ? "" : "s"} waiting for your approval
      </span>
      <button type="button" className="btn sm" onClick={jump}>
        Review
      </button>
    </div>
  );
}

const drafts = new Map<string, string>();

function Composer({ session, persona }: { session: SessionSummary; persona: PersonaSummary }) {
  const { state, actions } = useStore();
  const [text, setText] = useState(() => drafts.get(session.id) ?? "");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = isBusy(session.status);
  const starting = session.status === "starting";
  const provider = state.providers.find((p) => p.name === persona.model.provider);
  const canSend = text.trim().length > 0 && !starting && !sending;

  useEffect(() => {
    drafts.set(session.id, text);
  }, [session.id, text]);

  useEffect(() => {
    ref.current?.focus();
  }, [session.id]);

  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  // Auto-grow up to a limit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  const send = async () => {
    if (!canSend) return;
    const body = text;
    setSending(true);
    setText("");
    const ok = await actions.sendMessage(session.id, body);
    setSending(false);
    if (!ok) setText((cur) => (cur ? cur : body));
    ref.current?.focus();
  };

  const stop = async () => {
    setStopping(true);
    await actions.interrupt(session.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape" && busy) {
      e.preventDefault();
      void stop();
    }
  };

  const placeholder = starting
    ? "Starting the sandbox…"
    : session.status === "stopped"
      ? "Send a message to resume this session"
      : `Message ${persona.name}…`;

  return (
    <div className="composer-wrap">
      {provider && !provider.ready && (
        <div className="composer-warn">
          <IconWarning />
          Provider <b>{provider.name}</b> is not ready
          {provider.apiKeySecret && (
            <>
              {" "}
              — set <span className="mono">{provider.apiKeySecret}</span>
            </>
          )}
          .
          <button type="button" className="link-btn" onClick={() => actions.showView("credentials")}>
            Credentials
          </button>
        </div>
      )}
      <div className={cls("composer", starting && "disabled")}>
        <textarea
          id="composer-input"
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={starting}
          aria-label="Message"
        />
        <div className="composer-actions">
          {busy && (
            <button
              type="button"
              className="btn sm stop-btn"
              onClick={() => void stop()}
              disabled={stopping}
              title="Interrupt the agent (Esc)"
            >
              {stopping ? <Spinner size={10} /> : <IconStop size={11} />} Stop
            </button>
          )}
          <button
            type="button"
            className="btn primary sm send-btn"
            onClick={() => void send()}
            disabled={!canSend}
            title="Send (Enter)"
            aria-label="Send"
          >
            {sending ? <Spinner size={10} /> : <IconArrowUp />}
          </button>
        </div>
      </div>
      <div className="composer-hint">
        <span>
          <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> newline{busy && <> · <Kbd>Esc</Kbd> stop</>}
        </span>
        <span className="muted">
          {starting ? (
            <>
              <Spinner size={9} /> {session.statusDetail || "starting sandbox"}
            </>
          ) : (
            persona.id
          )}
        </span>
      </div>
    </div>
  );
}
