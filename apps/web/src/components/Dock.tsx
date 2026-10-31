import { useEffect, useRef, useState } from "react";
import { DOCK_DEFAULT, useStore, type DockMode } from "../store";
import { cls } from "../util";
import { MemoryUsagePane } from "./MemoryUsagePane";
import { NetworkPane } from "./NetworkPane";
import { AttachmentsPane } from "./AttachmentsPane";
import { SettingsPane } from "./SettingsPane";
import { SwanSettingsPane } from "./SwanSettings";

export const DOCK_MIN = 320;
const DOCK_LABEL: Record<DockMode, string> = {
  settings: "Settings",
  swan: "Swan settings",
  memory: "Memory",
  usage: "Usage",
  network: "Network activity",
  attachments: "Attachments",
};
export const DOCK_MAX = 560;

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

const clamp = (w: number) => Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.round(w)));

export function closeDockAndRestoreFocus(mode: DockMode, close: () => void) {
  close();
  // Swan settings opens from the persona menu, so focus goes back to its trigger.
  const trigger = mode === "swan" ? "persona-trigger" : `trigger-${mode}`;
  window.setTimeout(() => document.getElementById(trigger)?.focus(), 0);
}

export function Dock({ mode, overlay }: { mode: DockMode; overlay: boolean }) {
  const { state, actions } = useStore();
  const width = clamp(state.ui.widths[mode]);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; w: number } | null>(null);
  const shown = drag ?? width;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    setDrag(width);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    setDrag(clamp(start.current.w + (start.current.x - e.clientX)));
  };
  const onPointerUp = () => {
    if (start.current && drag !== null) actions.setDockWidth(mode, drag);
    start.current = null;
    setDrag(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") actions.setDockWidth(mode, clamp(width + step));
    else if (e.key === "ArrowRight") actions.setDockWidth(mode, clamp(width - step));
    else if (e.key === "Home") actions.setDockWidth(mode, DOCK_MIN);
    else if (e.key === "End") actions.setDockWidth(mode, DOCK_MAX);
    else return;
    e.preventDefault();
  };

  const close = () => closeDockAndRestoreFocus(mode, () => actions.openDock(null));

  return (
    <>
      {overlay && <div className="dock-backdrop" onClick={close} aria-hidden="true" />}
      <aside
        className={cls("dock", overlay && "overlay", drag !== null && "dragging")}
        style={overlay ? undefined : { width: shown }}
        aria-label={DOCK_LABEL[mode]}
        data-dock={mode}
      >
        {!overlay && (
          <div
            className="dock-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize pane"
            aria-valuemin={DOCK_MIN}
            aria-valuemax={DOCK_MAX}
            aria-valuenow={shown}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKey}
            onDoubleClick={() => actions.setDockWidth(mode, DOCK_DEFAULT)}
          />
        )}
        {mode === "settings" ? (
          <SettingsPane onClose={close} />
        ) : mode === "swan" ? (
          <SwanSettingsPane onClose={close} />
        ) : mode === "memory" || mode === "usage" ? (
          <MemoryUsagePane key={mode} mode={mode} onClose={close} />
        ) : mode === "network" ? (
          <NetworkPane onClose={close} />
        ) : (
          <AttachmentsPane onClose={close} />
        )}
      </aside>
    </>
  );
}
