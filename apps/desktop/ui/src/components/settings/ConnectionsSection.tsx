import type { PersonaSummary } from "@ph/shared";
import { allowanceLabel, isCredentialAllowance } from "../../status";
import { conversationSession, useStore } from "../../store";
import { ConnectionRules, AddConnection, newRule } from "./ConnectionRules";
import { Section, listSummary, type SectionProps } from "./Section";

/** The connections the persona uses and the rules for their credentials, with uses allowed until stopped. */
export function ConnectionsSection({ d, update, errors, persona, reveal }: SectionProps & { persona: PersonaSummary | null; reveal?: number }) {
  const { state, actions } = useStore();
  const session = persona ? conversationSession(state, persona.id) : null;
  const credAllowances = (session?.allowances ?? []).filter(isCredentialAllowance);
  return (
    <Section
      id="connections"
      title="Connections"
      summary={
        Object.keys(d.connections).length + credAllowances.length
          ? [
              Object.keys(d.connections).length && listSummary(Object.keys(d.connections), "connection"),
              credAllowances.length && `${credAllowances.length} until stopped`,
            ]
              .filter(Boolean)
              .join(" · ")
          : "None"
      }
      invalid={Object.keys(errors).some((k) => k.startsWith("rule-"))}
      reveal={reveal}
    >
      <p className="hint">
        Rules say what each credential may be used for. Checked deny, then ask, then allow; a request nothing allows goes out
        without the credential. Values are managed in{" "}
        <button type="button" className="link-btn inline" onClick={actions.openSwanSettings}>
          Swan settings
        </button>
        .
      </p>
      {Object.entries(d.connections).map(([conn, pc]) => (
        <ConnectionRules
          key={conn}
          name={conn}
          rules={pc.rules}
          status={state.connections.find((c) => c.name === conn)}
          errors={errors}
          onChange={(fn) => update((x) => fn(x.connections[conn].rules))}
          onRemove={() => update((x) => void delete x.connections[conn])}
        />
      ))}
      <AddConnection
        used={Object.keys(d.connections)}
        onAdd={(c) => update((x) => void (x.connections[c.name] = { rules: [newRule(c)] }))}
      />
      {credAllowances.length > 0 && session && (
        <div className="approved-hosts">
          <h4>Allowed in the conversation</h4>
          <p className="hint">From “Allow until stopped”. They end when the agent stops and never edit the persona.</p>
          <ul className="plain-list">
            {credAllowances.map((rule) => (
              <li key={rule} className="row gap">
                <span className="grow mono small">{allowanceLabel(rule)}</span>
                <button type="button" className="btn sm" onClick={() => void actions.removeAllowance(session.id, rule)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
