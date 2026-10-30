import { useEffect } from "react";
import { ConnectionLine, RuntimeLine, ServerGate, Toasts } from "./components/Banners";
import { Conversation } from "./components/Conversation";
import { closeDockAndRestoreFocus, Dock, useMediaQuery } from "./components/Dock";
import { FirstRun } from "./components/FirstRun";
import { Header } from "./components/Header";
import { Rail } from "./components/Rail";
import { conversationSession, useStore } from "./store";
import { isWorking } from "./status";

function useGlobalShortcuts(overlay: boolean) {
  const { actions } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = actions.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === "k") {
        if (s.personas.length === 0) return;
        e.preventDefault();
        actions.openPersonaMenu();
      } else if (mod && e.key === ".") {
        const session = conversationSession(s, s.selectedPersonaId);
        if (session && isWorking(session)) {
          e.preventDefault();
          void actions.interrupt(session.id);
        }
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        const dock = s.ui.dock;
        if (!dock) return;
        const inDock = (document.activeElement as HTMLElement | null)?.closest(".dock");
        if (overlay || inDock) {
          e.preventDefault();
          closeDockAndRestoreFocus(dock, () => actions.openDock(null));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, overlay]);
}

export function App() {
  const { state } = useStore();
  const overlay = useMediaQuery("(max-width: 1000px)");
  useGlobalShortcuts(overlay);

  const gated = state.server === "no-token" || state.server === "unauthorized" || !state.loaded;
  if (gated) {
    return (
      <>
        <ServerGate />
        <Toasts />
      </>
    );
  }

  const noPersonas = state.personas.length === 0;
  const dock = state.ui.dock;
  return (
    <div className="app">
      <Header />
      <div className="workspace">
        <main className="main">
          <ConnectionLine />
          <RuntimeLine />
          {noPersonas ? (
            <FirstRun />
          ) : (
            <Conversation />
          )}
        </main>
        {dock && <Dock mode={dock} overlay={overlay} />}
        <Rail />
      </div>
      <Toasts />
    </div>
  );
}
