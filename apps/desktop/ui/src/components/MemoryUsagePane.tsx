import { useEffect, useRef } from "react";
import { DEFAULT_MEMORY_PANE, useSelectedPersona, useStore, type MemoryPaneState } from "../store";
import { PaneHead } from "./Cards";
import { IconLock } from "./icons";
import { Empty, Segmented } from "./ui";
import { SavedMemory } from "./memory/SavedMemory";
import { CurrentWork } from "./memory/CurrentWork";
import { MemoryHistory } from "./memory/MemoryHistory";
import { UsageView } from "./memory/UsageView";

/** Scroll offsets per persona and view, kept for the session. */
const scrolls = new Map<string, number>();

/** Memory or Usage for the selected persona; both open from the overview and lead back to it. */
export function MemoryUsagePane({ mode, onBack }: { mode: "memory" | "usage"; onBack: () => void }) {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const bodyRef = useRef<HTMLDivElement>(null);
  const ps: MemoryPaneState = (persona && state.memoryPane[persona.id]) || DEFAULT_MEMORY_PANE;
  const scrollKey = persona ? `${persona.id}:${mode}:${mode === "memory" ? ps.sub : ""}` : "";
  const title = mode === "memory" ? "Memory" : "Usage";

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = scrolls.get(scrollKey) ?? 0;
  }, [scrollKey]);

  const head = <PaneHead title={title} sub={persona?.name} onBack={onBack} backLabel="Back to overview" />;

  if (!persona) {
    return (
      <div className="pane">
        {head}
        <div className="pane-body">
          <Empty title="No persona selected" />
        </div>
      </div>
    );
  }
  const set = (patch: Partial<MemoryPaneState>) => actions.setMemoryPane(persona.id, patch);

  return (
    <div className="pane">
      {head}
      {mode === "memory" && (
        <div className="pane-tabs">
          <Segmented
            label="Memory view"
            variant="tabs"
            value={ps.sub}
            onChange={(sub) => set({ sub })}
            options={[
              { value: "saved", label: "Saved" },
              { value: "current", label: "Current work" },
              { value: "history", label: "History" },
            ]}
          />
        </div>
      )}
      <div className="pane-body" ref={bodyRef} onScroll={(e) => scrolls.set(scrollKey, e.currentTarget.scrollTop)}>
        {mode === "usage" ? (
          <UsageView persona={persona} ps={ps} set={set} />
        ) : ps.sub === "saved" ? (
          <SavedMemory persona={persona} ps={ps} set={set} />
        ) : ps.sub === "current" ? (
          <CurrentWork persona={persona} />
        ) : (
          <MemoryHistory persona={persona} />
        )}
      </div>
      {mode === "memory" && (
        <div className="pane-foot quiet">
          <IconLock size={14} />
          <span>Private to {persona.name}</span>
        </div>
      )}
    </div>
  );
}
