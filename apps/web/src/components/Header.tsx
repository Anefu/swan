import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePendingApprovals, useSelectedPersona, useStore } from "../store";
import { personaModelLine, personaStatus } from "../status";
import { cls } from "../util";
import { IconCheck, IconChevronDown, IconDoc, IconPersonaAdd, IconSearch, IconSettings, IconTrend } from "./icons";
import { Kbd, MOD } from "./ui";

export function Header() {
  const { state, actions } = useStore();
  const dock = state.ui.dock;
  const settingsDirty = Object.values(state.drafts).some((d) => JSON.stringify(d.base) !== JSON.stringify(d.draft) || d.newId);
  return (
    <header className="app-header">
      <span className="wordmark" aria-label="Swan">
        Swan
      </span>
      {state.personas.length > 0 && <PersonaMenu />}
      <div className="grow" />
      <nav className="header-nav" aria-label="Panels">
        <button
          type="button"
          id="trigger-settings"
          className={cls("hbtn", dock === "settings" && "is-on")}
          aria-pressed={dock === "settings"}
          onClick={() => actions.toggleDock("settings")}
        >
          <IconSettings size={18} />
          <span>Settings</span>
          {settingsDirty && (
            <span className="hbtn-note">
              <span className="dot attention" aria-hidden="true" />
              Unsaved
            </span>
          )}
        </button>
        <button
          type="button"
          id="trigger-memory"
          className={cls("hbtn", dock === "memory" && "is-on")}
          aria-pressed={dock === "memory"}
          disabled={!state.selectedPersonaId}
          onClick={() => actions.toggleDock("memory")}
        >
          <IconDoc size={18} />
          <span>Memory &amp; Usage</span>
        </button>
        <button
          type="button"
          className={cls("hbtn plain", state.view === "network" && "is-on")}
          aria-pressed={state.view === "network"}
          onClick={() => actions.showView(state.view === "network" ? "conversation" : "network")}
        >
          <IconTrend size={18} />
          <span>Network activity</span>
        </button>
      </nav>
    </header>
  );
}

function PersonaMenu() {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const approvals = usePendingApprovals();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const showSearch = state.personas.length > 6;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.personas;
    return state.personas.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q));
  }, [state.personas, query]);
  // The last entry is always "New persona".
  const count = filtered.length + 1;

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  };

  const openMenu = () => {
    setOpen(true);
    const i = state.personas.findIndex((p) => p.id === state.selectedPersonaId);
    setActive(Math.max(0, i));
  };

  // Cmd+K
  const seq = state.personaMenuSeq;
  const firstSeq = useRef(seq);
  useEffect(() => {
    if (seq !== firstSeq.current) openMenu();
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    if (showSearch) searchRef.current?.focus();
    else listRef.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active >= count) setActive(count - 1);
  }, [count, active]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  const choose = (i: number) => {
    if (i === filtered.length) {
      close(false);
      actions.openSettings("persona", { isNew: true });
      return;
    }
    const p = filtered[i];
    if (!p) return;
    actions.selectPersona(p.id);
    actions.showView("conversation");
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + count) % count);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(count - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <div className="persona-menu">
      <button
        ref={triggerRef}
        type="button"
        className={cls("persona-trigger", open && "is-open")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Persona: ${persona?.name ?? "none"}. Switch persona (${MOD}K)`}
        onClick={() => (open ? close() : openMenu())}
      >
        <span>{persona?.name ?? "Choose persona"}</span>
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div ref={popRef} className="popover persona-pop" onKeyDown={onKeyDown}>
          {showSearch && (
            <label className="search-field">
              <IconSearch size={16} />
              <span className="sr-only">Find a persona</span>
              <input
                ref={searchRef}
                placeholder="Find a persona"
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
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Personas"
            tabIndex={showSearch ? -1 : 0}
            aria-activedescendant={`${listId}-${active}`}
            className="persona-list"
          >
            {filtered.map((p, i) => {
              const st = personaStatus(state, p, approvals);
              const selected = p.id === state.selectedPersonaId;
              return (
                <li
                  key={p.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={selected}
                  className={cls("persona-opt", i === active && "is-active")}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                >
                  <span className="persona-check">{selected && <IconCheck size={16} />}</span>
                  <span className="persona-opt-main">
                    <span className={cls("persona-opt-name", selected && "strong")}>{p.name}</span>
                    <span className="persona-opt-model">{personaModelLine(state, p)}</span>
                  </span>
                  {st && <span className={cls("status-text", `tone-${st.tone}`)}>{st.text}</span>}
                </li>
              );
            })}
            {filtered.length === 0 && <li className="persona-none">No persona matches “{query}”.</li>}
            <li role="separator" className="sep" aria-hidden="true" />
            <li
              id={`${listId}-${filtered.length}`}
              role="option"
              aria-selected={false}
              className={cls("persona-opt new", active === filtered.length && "is-active")}
              onMouseEnter={() => setActive(filtered.length)}
              onClick={() => choose(filtered.length)}
            >
              <span className="persona-check">
                <IconPersonaAdd size={16} />
              </span>
              <span className="persona-opt-main">New persona</span>
            </li>
          </ul>
          <div className="pop-hint">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move · <Kbd>Enter</Kbd> open · <Kbd>Esc</Kbd> close
          </div>
        </div>
      )}
    </div>
  );
}
