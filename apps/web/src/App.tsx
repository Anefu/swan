import { useEffect } from "react";
import { ConnectionBanner, RuntimeBanner, ServerGate, Toasts } from "./components/Banners";
import { ChatView } from "./components/ChatView";
import { CredentialsView } from "./components/CredentialsView";
import { NewPersonaDialog } from "./components/NewPersonaDialog";
import { RightPanel } from "./components/RightPanel";
import { Sidebar } from "./components/Sidebar";
import { sessionsForPersona, useStore } from "./store";
import { isEditableTarget } from "./util";

function useGlobalShortcuts() {
  const { actions } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = actions.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "\\") {
        e.preventDefault();
        actions.setUi({ rightOpen: !s.ui.rightOpen });
      } else if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown") && s.selectedPersonaId) {
        const list = sessionsForPersona(s, s.selectedPersonaId);
        if (list.length === 0) return;
        e.preventDefault();
        const i = list.findIndex((x) => x.id === s.selectedSessionId);
        const next = e.key === "ArrowDown" ? (i < 0 ? 0 : Math.min(list.length - 1, i + 1)) : i < 0 ? 0 : Math.max(0, i - 1);
        actions.selectSession(list[next].id);
      } else if (e.altKey && !mod && e.code === "KeyN" && s.selectedPersonaId) {
        e.preventDefault();
        const p = s.personas.find((x) => x.id === s.selectedPersonaId);
        if (p && p.errors.length === 0) void actions.createSession(p.id);
      } else if (e.key === "/" && !mod && !e.altKey && !isEditableTarget(e.target) && !document.querySelector(".modal")) {
        const el = document.getElementById("composer-input");
        if (el) {
          e.preventDefault();
          el.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions]);
}

export function App() {
  const { state } = useStore();
  useGlobalShortcuts();

  const gated = state.server === "no-token" || state.server === "unauthorized" || !state.loaded;
  if (gated) {
    return (
      <>
        <ServerGate />
        <Toasts />
      </>
    );
  }

  const showRight = state.ui.rightOpen && state.view === "chat";
  return (
    <div className={showRight ? "app with-right" : "app"}>
      <Sidebar />
      <main className="main">
        <ConnectionBanner />
        <RuntimeBanner />
        <div className="main-body">{state.view === "credentials" ? <CredentialsView /> : <ChatView />}</div>
      </main>
      {showRight && <RightPanel />}
      <Toasts />
      {state.dialog?.kind === "new-persona" && <NewPersonaDialog />}
    </div>
  );
}
