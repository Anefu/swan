import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Effort, ModelOption, PersonaSummary, SessionSummary, SlashCommand } from "@ph/shared";
import { api } from "../api";
import { usePendingApprovals, useStore } from "../store";
import { isWorking, plural } from "../status";
import { ALL_EFFORTS, cls, EFFORT_LABEL } from "../util";
import { IconArrowRight, IconSend, IconStop } from "./icons";
import { MOD, Spinner } from "./ui";

const SWAN_COMMANDS: SlashCommand[] = [
  { name: "dream", description: "Consolidate memory now", source: "swan" },
  { name: "stop", description: "Stop the agent and clear allowances", source: "swan" },
  { name: "usage", description: "Open usage for this persona", source: "swan" },
];

const commandCache = new Map<string, SlashCommand[]>();

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

  // Auto-grow
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
  }, [text]);

  const submit = async (raw: string) => {
    const value = raw.trim();
    if (!value || sending) return;
    if (value === "/usage") {
      setText("");
      actions.openUsage(persona.id);
      return;
    }
    if (!sessionId) {
      actions.toast("warn", "The conversation is still opening. Your draft is kept.");
      return;
    }
    setSending(true);
    const ok = await actions.sendMessage(sessionId, value);
    setSending(false);
    if (ok) setText("");
    taRef.current?.focus();
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
        <div className="composer-row">
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
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={menuOpen ? optId(menuIndex) : undefined}
            aria-autocomplete="list"
            spellCheck
          />
          <button
            type="button"
            className="send-btn"
            aria-label={working ? "Send (will steer the next step)" : "Send"}
            title={working ? "Send. The agent uses it before its next decision." : "Send (Enter)"}
            disabled={!text.trim() || sending}
            onClick={() => void submit(text)}
          >
            {sending ? <Spinner size={16} /> : <IconSend size={20} />}
          </button>
          {working && sessionId && (
            <button
              type="button"
              className="btn stop-btn"
              title={`Stop now (${MOD}.)`}
              onClick={() => void actions.interrupt(sessionId)}
            >
              <IconStop size={14} />
              Stop
            </button>
          )}
        </div>
        <div className="composer-meta">
          <ModelSelectors persona={persona} />
          <span className="grow" />
          <DecisionsShortcut />
        </div>
      </div>
    </div>
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
