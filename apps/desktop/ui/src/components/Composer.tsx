import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Effort, ModelOption, PersonaSummary, SessionSummary, SlashCommand } from "@ph/shared";
import { api } from "../api";
import { usePendingApprovals, useStore, type DraftAttachment } from "../store";
import { isWorking, plural } from "../status";
import { ALL_EFFORTS, cls, EFFORT_LABEL, fmtBytes } from "../util";
import { IconArrowRight, IconArrowUp, IconFile, IconPaperclip, IconStop, IconX } from "./icons";
import { MOD, Spinner } from "./ui";

const SWAN_COMMANDS: SlashCommand[] = [
  { name: "dream", description: "Consolidate memory now", source: "swan" },
  { name: "stop", description: "Stop the agent and clear allowances", source: "swan" },
  { name: "usage", description: "Open usage for this persona", source: "swan" },
];

const commandCache = new Map<string, SlashCommand[]>();

/** Grows the message box with its text, up to its CSS max-height; past that it scrolls. */
function fitHeight(ta: HTMLTextAreaElement | null) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
}

function useCommands(persona: PersonaSummary): SlashCommand[] {
  const { state } = useStore();
  const [cmds, setCmds] = useState<SlashCommand[] | null>(() => commandCache.get(persona.id) ?? null);
  const skillsKey = persona.skills.join(",");
  useEffect(() => {
    let alive = true;
    setCmds(commandCache.get(persona.id) ?? null);
    api
      .commands(persona.id)
      .then((list) => {
        commandCache.set(persona.id, list);
        if (alive) setCmds(list);
      })
      .catch(() => {
        if (alive) setCmds(null);
      });
    return () => {
      alive = false;
    };
  }, [persona.id, skillsKey]);
  return useMemo(() => {
    if (cmds) return [...cmds.filter((c) => c.source === "swan"), ...cmds.filter((c) => c.source === "skill")];
    // Fallback while the server has no commands endpoint: Swan commands, then the persona's skills.
    const skills = persona.skills.map<SlashCommand>((name) => ({
      name,
      description: state.skills.find((s) => s.name === name)?.description ?? "Load and follow this skill",
      source: "skill",
    }));
    return [...SWAN_COMMANDS, ...skills];
  }, [cmds, persona.skills, state.skills]);
}

export function Composer({
  persona,
  session,
  sessionId,
}: {
  persona: PersonaSummary;
  session: SessionSummary | null;
  sessionId: string | null;
}) {
  const { state, actions } = useStore();
  const text = state.composer[persona.id] ?? "";
  const setText = (t: string) => actions.setComposer(persona.id, t);
  const [sending, setSending] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const commands = useCommands(persona);
  const working = isWorking(session);
  const menuId = useId();

  const slashQuery = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  const matches = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
    const contains = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    return [...starts, ...contains];
  }, [slashQuery, commands]);
  const menuOpen = slashQuery !== null && !menuDismissed && matches.length > 0;

  useEffect(() => setMenuIndex(0), [slashQuery]);
  useEffect(() => {
    if (slashQuery === null) setMenuDismissed(false);
  }, [slashQuery]);

  // Auto-grow, and again when the width changes (window or side panel), since the text re-wraps.
  useLayoutEffect(() => fitHeight(taRef.current), [text]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    let width = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth === width) return;
      width = ta.clientWidth;
      fitHeight(ta);
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);

  const atts = state.attachments[persona.id] ?? [];
  const uploading = atts.some((a) => a.status === "uploading");
  const failed = atts.some((a) => a.status === "error");
  const ready = atts.filter((a) => a.status === "done" && a.meta);
  const canSend = (!!text.trim() || ready.length > 0) && !uploading && !failed && !sending;
  const blockReason = uploading ? "Waiting for uploads to finish" : failed ? "Remove the attachments that failed first" : null;

  const submit = async (raw: string) => {
    const value = raw.trim();
    if (sending || (!value && ready.length === 0)) return;
    if (blockReason) {
      actions.toast("info", `${blockReason}.`);
      return;
    }
    if (value === "/usage" && ready.length === 0) {
      setText("");
      actions.openUsage();
      return;
    }
    if (!sessionId) {
      actions.toast("warn", "The conversation is still opening. Your draft is kept.");
      return;
    }
    setSending(true);
    const ok = await actions.sendMessage(
      sessionId,
      value,
      ready.map((a) => a.meta!.id),
    );
    setSending(false);
    if (ok) {
      setText("");
      actions.clearAttachments(
        persona.id,
        ready.map((a) => a.key),
      );
    }
    taRef.current?.focus();
  };

  const fileRef = useRef<HTMLInputElement>(null);
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    // Screenshots arrive as files only; keep normal text paste when text is present too.
    if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
    actions.addAttachments(persona.id, files);
  };

  const pick = (c: SlashCommand, run: boolean) => {
    const t = `/${c.name}${c.source === "swan" ? "" : " "}`;
    if (run && c.source === "swan") {
      void submit(t);
      return;
    }
    setText(t);
    setMenuDismissed(true);
    taRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        pick(matches[menuIndex], false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        pick(matches[menuIndex], true);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(text);
    }
  };

  const swanMatches = matches.filter((c) => c.source === "swan");
  const skillMatches = matches.filter((c) => c.source === "skill");
  const optId = (i: number) => `${menuId}-o${i}`;

  return (
    <div className="composer-area">
      {menuOpen && (
        <div className="popover command-menu" role="listbox" id={menuId} aria-label="Commands">
          {swanMatches.length > 0 && <div className="menu-group">Swan</div>}
          {swanMatches.map((c) => {
            const i = matches.indexOf(c);
            return <CommandOption key={`s-${c.name}`} id={optId(i)} c={c} active={i === menuIndex} onHover={() => setMenuIndex(i)} onPick={() => pick(c, true)} />;
          })}
          {skillMatches.length > 0 && <div className={cls("menu-group", swanMatches.length > 0 && "sep-top")}>Skills</div>}
          {skillMatches.map((c) => {
            const i = matches.indexOf(c);
            return <CommandOption key={`k-${c.name}`} id={optId(i)} c={c} active={i === menuIndex} onHover={() => setMenuIndex(i)} onPick={() => pick(c, false)} />;
          })}
        </div>
      )}
      <div className={cls("composer", text.startsWith("/") && "is-command")}>
        {atts.length > 0 && (
          <ul className="att-chips" aria-label="Attachments">
            {atts.map((a) => (
              <AttachmentChip key={a.key} a={a} onRemove={() => actions.removeAttachment(persona.id, a.key)} />
            ))}
          </ul>
        )}
        {/* One line when empty; grows with the text. Model and effort are below the box. */}
        <div className="composer-row">
          <button
            type="button"
            className="icon-btn sm attach-btn"
            aria-label="Attach files"
            title="Attach files (or paste, or drop them here)"
            onClick={() => fileRef.current?.click()}
          >
            <IconPaperclip size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) actions.addAttachments(persona.id, files);
              e.target.value = "";
              taRef.current?.focus();
            }}
          />
          <label htmlFor="composer-input" className="sr-only">
            Message {persona.name}
          </label>
          <textarea
            id="composer-input"
            ref={taRef}
            rows={1}
            value={text}
            placeholder={`Message ${persona.name}…  (/ for commands)`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={menuOpen ? optId(menuIndex) : undefined}
            aria-autocomplete="list"
            spellCheck
          />
          <SendStopButton
            hasText={!!text.trim() || atts.length > 0}
            canSend={canSend}
            blockReason={blockReason}
            sending={sending || uploading}
            working={working}
            onSend={() => void submit(text)}
            onStop={sessionId ? () => void actions.interrupt(sessionId) : undefined}
          />
        </div>
      </div>
      <div className="composer-pickers">
        <DecisionsShortcut className="compact" />
        <span className="grow" />
        <ModelSelectors persona={persona} />
      </div>
    </div>
  );
}

/** One small round button: Send when there is a draft (queued as steering while the agent works), Stop when working with an empty draft. */
function SendStopButton({
  hasText,
  canSend,
  blockReason,
  sending,
  working,
  onSend,
  onStop,
}: {
  hasText: boolean;
  canSend: boolean;
  blockReason: string | null;
  sending: boolean;
  working: boolean;
  onSend: () => void;
  onStop?: () => void;
}) {
  const stop = working && !hasText && !!onStop;
  if (stop) {
    return (
      <button type="button" className="round-btn stop" aria-label={`Stop (${MOD}.)`} title={`Stop (${MOD}.)`} onClick={onStop}>
        <IconStop size={12} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="round-btn"
      aria-label={blockReason ? `Send (${blockReason.toLowerCase()})` : working ? "Send; it steers the next step" : "Send"}
      title={blockReason ?? (working ? "Send (Enter). The agent uses it before its next decision." : "Send (Enter)")}
      disabled={!canSend}
      onClick={onSend}
    >
      {sending ? <Spinner size={12} /> : <IconArrowUp size={16} />}
    </button>
  );
}

function AttachmentChip({ a, onRemove }: { a: DraftAttachment; onRemove: () => void }) {
  const label = `${a.name}, ${fmtBytes(a.size)}${a.status === "uploading" ? ", uploading" : a.status === "error" ? `, failed: ${a.error}` : ""}`;
  return (
    <li className={cls("att-chip", a.status === "error" && "is-error")} title={a.meta?.sandboxPath ?? a.error ?? a.name}>
      {a.previewUrl ? <img src={a.previewUrl} alt="" className="att-thumb" /> : <IconFile size={16} className="att-icon" />}
      <span className="att-text">
        <span className="att-name">{a.name}</span>
        <span className={cls("att-meta", a.status === "error" && "tone-error")}>
          {a.status === "error" ? a.error : a.status === "uploading" ? `${Math.round(a.progress * 100)}%` : fmtBytes(a.size)}
        </span>
      </span>
      {a.status === "uploading" && <Spinner size={10} />}
      <span className="sr-only">{label}</span>
      <button type="button" className="icon-btn sm" aria-label={`Remove ${a.name}`} onClick={onRemove}>
        <IconX size={12} />
      </button>
      {a.status === "uploading" && <span className="att-progress" style={{ width: `${Math.round(a.progress * 100)}%` }} aria-hidden="true" />}
    </li>
  );
}

function CommandOption({
  id,
  c,
  active,
  onHover,
  onPick,
}: {
  id: string;
  c: SlashCommand;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={active}
      className={cls("command-opt", active && "is-active")}
      onMouseEnter={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span className="command-name mono">/{c.name}</span>
      <span className="command-desc">{c.description}</span>
    </div>
  );
}

const SEP = "\u0001";

function ModelSelectors({ persona }: { persona: PersonaSummary }) {
  const { state, actions } = useStore();
  const [busy, setBusy] = useState(false);
  const current = state.models?.find((m) => m.provider === persona.model.provider && m.id === persona.model.id) ?? null;
  const options: ModelOption[] = state.models ?? [];
  const groups = useMemo(() => {
    const g = new Map<string, ModelOption[]>();
    for (const m of options) {
      const list = g.get(m.provider) ?? [];
      list.push(m);
      g.set(m.provider, list);
    }
    return [...g.entries()];
  }, [options]);
  const efforts: Effort[] = current ? current.efforts : state.models ? [] : persona.model.effort ? ALL_EFFORTS : [];

  const change = async (body: { provider: string; id: string; effort?: Effort }) => {
    setBusy(true);
    await actions.setModel(persona.id, body);
    setBusy(false);
  };

  return (
    <>
      <label className="mini-select">
        <span className="sr-only">Model</span>
        <select
          value={`${persona.model.provider}${SEP}${persona.model.id}`}
          disabled={busy || !state.models}
          title={state.models ? "Model for the next turn (saved to the persona)" : "Model list unavailable"}
          onChange={(e) => {
            const [provider, id] = e.target.value.split(SEP);
            const next = options.find((m) => m.provider === provider && m.id === id);
            const effort = persona.model.effort && next?.efforts.includes(persona.model.effort) ? persona.model.effort : undefined;
            void change({ provider, id, effort });
          }}
        >
          {!current && (
            <option value={`${persona.model.provider}${SEP}${persona.model.id}`}>{persona.model.id}</option>
          )}
          {groups.map(([provider, list]) => (
            <optgroup key={provider} label={provider}>
              {list.map((m) => (
                <option key={m.id} value={`${m.provider}${SEP}${m.id}`} disabled={!m.ready && m !== current}>
                  {m.label}
                  {m.preview ? " · Preview" : ""}
                  {!m.ready ? " · needs key" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {efforts.length > 0 && (
        <label className="mini-select">
          <span className="sr-only">Effort</span>
          <select
            value={persona.model.effort ?? ""}
            disabled={busy}
            title="Reasoning effort for the next turn (saved to the persona)"
            onChange={(e) => {
              const effort = (e.target.value || undefined) as Effort | undefined;
              void change({ provider: persona.model.provider, id: persona.model.id, effort });
            }}
          >
            {!persona.model.effort && <option value="">Effort: default</option>}
            {efforts.map((ef) => (
              <option key={ef} value={ef}>
                Effort: {EFFORT_LABEL[ef]}
              </option>
            ))}
          </select>
        </label>
      )}
      {busy && <Spinner size={12} label="Saving model" />}
    </>
  );
}

/** "N decisions · Review", reachable in one action from every main view and pane. */
export function DecisionsShortcut({ className }: { className?: string }) {
  const { actions } = useStore();
  const approvals = usePendingApprovals();
  if (approvals.length === 0) return null;
  return (
    <button type="button" className={cls("decisions-btn", className)} onClick={() => actions.jumpToApproval()}>
      {plural(approvals.length, "decision")} · Review
      <IconArrowRight size={14} />
    </button>
  );
}
