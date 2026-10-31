import type { ReactNode } from "react";
import { usePendingApprovals, useStore, type DockMode } from "../store";
import { cls } from "../util";
import { IconChart, IconDoc, IconPaperclip, IconSettings, IconShield, IconTrend } from "./icons";

const ENTRIES: Array<{ mode: DockMode; label: string; icon: ReactNode }> = [
  { mode: "settings", label: "Settings", icon: <IconSettings size={18} /> },
  { mode: "memory", label: "Memory", icon: <IconDoc size={18} /> },
  { mode: "usage", label: "Usage", icon: <IconChart size={18} /> },
  { mode: "network", label: "Network activity", icon: <IconTrend size={18} /> },
  { mode: "attachments", label: "Attachments", icon: <IconPaperclip size={18} /> },
];

/** Panel buttons at the right of the header; they switch the dock. Clicking the active entry closes it. */
export function Rail() {
  const { state, actions } = useStore();
  const approvals = usePendingApprovals();
  const dock = state.ui.dock;
  const settingsDirty = Object.values(state.drafts).some((d) => JSON.stringify(d.base) !== JSON.stringify(d.draft) || d.newId);
  const needsPersona = (m: DockMode) => m !== "settings" && !state.selectedPersonaId;
  return (
    <nav className="header-tools" aria-label="Panels">
      {approvals.length > 0 && (
        <button
          type="button"
          className="rail-btn attention"
          aria-label={`${approvals.length} ${approvals.length === 1 ? "decision" : "decisions"} waiting. Review`}
          title={`${approvals.length} ${approvals.length === 1 ? "decision" : "decisions"} waiting · Review`}
          onClick={() => actions.jumpToApproval()}
        >
          <IconShield size={18} />
          <span className="rail-count">{approvals.length}</span>
        </button>
      )}
      {ENTRIES.map((e) => {
        const on = dock === e.mode;
        const note = e.mode === "settings" && settingsDirty ? " (unsaved changes)" : "";
        return (
          <button
            key={e.mode}
            type="button"
            id={`trigger-${e.mode}`}
            className={cls("rail-btn", on && "is-on")}
            aria-pressed={on}
            aria-label={`${e.label}${note}`}
            title={`${e.label}${note}`}
            disabled={needsPersona(e.mode)}
            onClick={() => actions.toggleDock(e.mode)}
          >
            {e.icon}
            {note && <span className="rail-dot" aria-hidden="true" />}
          </button>
        );
      })}
    </nav>
  );
}
