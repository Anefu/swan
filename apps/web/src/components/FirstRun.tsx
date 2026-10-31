import { useStore } from "../store";
import { IconCheck } from "./icons";

/** One empty-state card: create a persona, add a model key. */
export function FirstRun() {
  const { state, actions } = useStore();
  const keyReady = state.providers.some((p) => p.ready);
  return (
    <div className="first-run">
      <section className="card first-card" aria-labelledby="first-title">
        <h1 id="first-title">Welcome to Swan</h1>
        <p className="muted">
          A persona is an agent with its own folders, allowed hosts, credentials and rules. It works in a sandbox and never sees a
          secret.
        </p>
        <ol className="first-steps">
          <li>
            <span className="step-text">
              <strong>Add a model key</strong>
              <span className="muted small">{keyReady ? "A provider is ready." : "Anthropic, OpenAI or GitHub Copilot (Preview)."}</span>
            </span>
            {keyReady ? (
              <span className="status-text tone-muted">
                <IconCheck /> Done
              </span>
            ) : null}
            <button type="button" className={keyReady ? "btn" : "btn primary"} onClick={actions.openSwanSettings}>
              {keyReady ? "Review keys" : "Add a model key"}
            </button>
          </li>
          <li>
            <span className="step-text">
              <strong>Create a persona</strong>
              <span className="muted small">Choose its folders and what it may do without asking.</span>
            </span>
            <button
              type="button"
              className={keyReady ? "btn primary" : "btn"}
              onClick={() => actions.openSettings({ isNew: true })}
            >
              Create a persona
            </button>
          </li>
        </ol>
      </section>
    </div>
  );
}
