import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useSelectedPersona, useSelectedSession, useStore, type RightTab } from "../store";
import { cls } from "../util";
import { IconX } from "./icons";
import { NetworkTab } from "./NetworkTab";
import { PersonaTab } from "./PersonaTab";
import { ToolsTab } from "./ToolsTab";
import { EmptyState } from "./ui";
import { WorkspaceTab } from "./WorkspaceTab";

const TABS: Array<{ id: RightTab; label: string }> = [
  { id: "workspace", label: "Workspace" },
  { id: "tools", label: "Tools" },
  { id: "network", label: "Network" },
  { id: "persona", label: "Persona" },
];

const MIN_W = 300;
const MAX_W = 1000;

export function RightPanel() {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const session = useSelectedSession();
  const tab = state.ui.rightTab;
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startW: state.ui.rightWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !panelRef.current) return;
    const w = Math.max(MIN_W, Math.min(MAX_W, drag.current.startW + (drag.current.startX - e.clientX)));
    panelRef.current.style.width = `${w}px`;
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const w = Math.max(MIN_W, Math.min(MAX_W, drag.current.startW + (drag.current.startX - e.clientX)));
    drag.current = null;
    actions.setUi({ rightWidth: w });
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    actions.setUi({ rightTab: next.id });
    document.getElementById(`rtab-${next.id}`)?.focus();
    e.preventDefault();
  };

  return (
    <aside ref={panelRef} className="right" style={{ width: state.ui.rightWidth }} aria-label="Details panel">
      <div
        className="right-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="right-head">
        <div className="tabs" role="tablist" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`rtab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              className={cls("tab", tab === t.id && "active")}
              onClick={() => actions.setUi({ rightTab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close panel"
          title="Close panel (Ctrl+\)"
          onClick={() => actions.setUi({ rightOpen: false })}
        >
          <IconX />
        </button>
      </div>
      <div className="right-body" role="tabpanel" aria-labelledby={`rtab-${tab}`}>
        {!persona ? (
          tab === "network" ? (
            <NetworkTab session={null} />
          ) : (
            <EmptyState title="No persona selected">Select a persona to see its workspace, tools and config.</EmptyState>
          )
        ) : tab === "workspace" ? (
          <WorkspaceTab key={persona.id} persona={persona} />
        ) : tab === "tools" ? (
          <ToolsTab persona={persona} session={session} />
        ) : tab === "network" ? (
          <NetworkTab session={session} />
        ) : (
          <PersonaTab key={persona.id} persona={persona} />
        )}
      </div>
    </aside>
  );
}
