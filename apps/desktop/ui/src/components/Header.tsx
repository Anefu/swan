import { useEffect, useMemo, useRef } from "react";
import { usePendingApprovals, useSelectedPersona, useStore } from "../store";
import { personaModelLine, personaStatus } from "../status";
import { cls } from "../util";
import { IconCheck, IconChevronDown, IconPersonaAdd, IconUpload } from "./icons";
import { MenuList, MenuOption, MenuSearch, useListMenu } from "./ListMenu";
import { ConversationMenu } from "./ConversationMenu";
import { Rail } from "./Rail";
import { Kbd, MOD } from "./ui";

/** Title bar: the persona picker on the left, the panel buttons and Swan settings on the right. */
export function Header() {
  const { state } = useStore();
  return (
    <header className="app-header">
      {state.personas.length > 0 && <PersonaMenu />}
      {state.selectedPersonaId && <ConversationMenu personaId={state.selectedPersonaId} />}
      <Rail />
    </header>
  );
}

function PersonaMenu() {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const approvals = usePendingApprovals();
  const fileRef = useRef<HTMLInputElement>(null);
  const showSearch = state.personas.length > 6;
  const menu = useListMenu({ count: () => filtered.length + 2, choose: (i) => choose(i) });
  const query = menu.query;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.personas;
    return state.personas.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q));
  }, [state.personas, query]);
  // After the personas: "New persona", then "Import persona…".
  const newIndex = filtered.length;
  const importIndex = filtered.length + 1;

  const choose = (i: number) => {
    if (i === newIndex) {
      menu.close(false);
      actions.openSettings({ isNew: true });
    } else if (i === importIndex) {
      menu.close(false);
      fileRef.current?.click();
    } else if (filtered[i]) {
      actions.selectPersona(filtered[i].id);
      menu.close();
    }
  };
  const openMenu = () => menu.openAt(state.personas.findIndex((p) => p.id === state.selectedPersonaId));

  // Cmd+K
  const seq = state.personaMenuSeq;
  const firstSeq = useRef(seq);
  useEffect(() => {
    if (seq !== firstSeq.current) openMenu();
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // Keys are handled on the wrapper so they work even before focus has moved into the list.
    <div ref={menu.rootRef} className="persona-menu" onKeyDown={menu.onKeyDown}>
      <button
        ref={menu.triggerRef}
        id="persona-trigger"
        type="button"
        className={cls("persona-trigger", menu.open && "is-open")}
        aria-haspopup="listbox"
        aria-expanded={menu.open}
        aria-label={`Persona: ${persona?.name ?? "none"}. Switch persona (${MOD}K)`}
        onClick={() => (menu.open ? menu.close() : openMenu())}
      >
        <span>{persona?.name ?? "Choose persona"}</span>
        <IconChevronDown size={14} />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".yaml,.yml"
        hidden
        aria-label="Persona file to import"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void actions.startImport(file);
        }}
      />
      {menu.open && (
        <div className="popover persona-pop">
          {showSearch && <MenuSearch menu={menu} label="Find a persona" />}
          <MenuList menu={menu} label="Personas" searching={showSearch}>
            {filtered.map((p, i) => {
              const st = personaStatus(state, p, approvals);
              const selected = p.id === state.selectedPersonaId;
              return (
                <MenuOption
                  key={p.id}
                  menu={menu}
                  index={i}
                  onChoose={choose}
                  selected={selected}
                  mark={selected && <IconCheck size={16} />}
                  aside={st && <span className={cls("status-text", `tone-${st.tone}`)}>{st.text}</span>}
                >
                  <span className={cls("persona-opt-name", selected && "strong")}>{p.name}</span>
                  <span className="persona-opt-model">{personaModelLine(state, p)}</span>
                </MenuOption>
              );
            })}
            {filtered.length === 0 && <li className="persona-none">No persona matches “{query}”.</li>}
            <li role="separator" className="sep" aria-hidden="true" />
            <MenuOption menu={menu} index={newIndex} onChoose={choose} className="new" mark={<IconPersonaAdd size={16} />}>
              New persona
            </MenuOption>
            <MenuOption menu={menu} index={importIndex} onChoose={choose} className="new" mark={<IconUpload size={16} />}>
              Import persona…
            </MenuOption>
          </MenuList>
          <div className="pop-hint">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move · <Kbd>Enter</Kbd> open · <Kbd>Esc</Kbd> close
          </div>
        </div>
      )}
    </div>
  );
}
