import type { PersonaSummary, PermissionMode } from "@ph/shared";
import { allowanceLabel, isCredentialAllowance } from "../../status";
import { conversationSession, useStore } from "../../store";
import { sameJson } from "../../util";
import { Field } from "../ui";
import { Section, plural, type SectionProps } from "./Section";

const PERMISSION_LABEL: Record<PermissionMode, string> = { allow: "Allow", ask: "Ask", deny: "Deny" };

/** The persona's rules for tool calls, and what was allowed in the conversation until stopped. */
export function PermissionsSection({ d, update, persona }: Omit<SectionProps, "errors"> & { persona: PersonaSummary | null }) {
  const { state, actions } = useStore();
  const session = persona ? conversationSession(state, persona.id) : null;
  const toolAllowances = (session?.allowances ?? []).filter((r) => !r.startsWith("net:") && !isCredentialAllowance(r));
  return (
    <Section
      id="permissions"
      title="Permissions"
      summary={`${PERMISSION_LABEL[d.permissions.default]} · ${plural(
        d.permissions.allow.length + d.permissions.ask.length + d.permissions.deny.length,
        "rule",
      )}`}
    >
      <p className="hint">
        Checked in order: deny, allow, ask, then the default. Rules look like <span className="mono">read_file</span>,{" "}
        <span className="mono">mcp__github__*</span>, or a command pattern such as <span className="mono">cd *</span> or{" "}
        <span className="mono">npm test*</span>. A command that joins several, like <span className="mono">cd app &amp;&amp; npm test</span>,
        is allowed when every part is. Applies to the next call.
      </p>
      <Field label="Default for anything unmatched">
        {(f) => (
          <select
            {...f}
            className="input"
            value={d.permissions.default}
            onChange={(e) => update((x) => void (x.permissions.default = e.target.value as PermissionMode))}
          >
            <option value="allow">Allow</option>
            <option value="ask">Ask</option>
            <option value="deny">Deny</option>
          </select>
        )}
      </Field>
      {(["allow", "ask", "deny"] as const).map((k) => (
        <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)} (one rule per line)`}>
          {(f) => (
            <textarea
              {...f}
              className="input mono"
              rows={Math.max(2, d.permissions[k].length + 1)}
              value={d.permissions[k].join("\n")}
              onChange={(e) =>
                update((x) => void (x.permissions[k] = e.target.value.split("\n")))
              }
              onBlur={() => {
                const clean = d.permissions[k].map((r) => r.trim()).filter(Boolean);
                if (!sameJson(clean, d.permissions[k])) update((x) => void (x.permissions[k] = clean));
              }}
            />
          )}
        </Field>
      ))}
      {persona && (
        <div className="allowances">
          <h4>Temporary allowances</h4>
          <p className="hint">
            From “Allow … until stopped”. They end when the agent stops or Swan restarts; they never edit the persona. Hosts and
            credential uses approved this way are listed under Allowed hosts and Connections.
          </p>
          {!session || toolAllowances.length === 0 ? (
            <p className="muted small">None active.</p>
          ) : (
            <>
              <ul className="plain-list">
                {toolAllowances.map((rule) => (
                  <li key={rule} className="row gap">
                    <span className="mono grow">{allowanceLabel(rule)}</span>
                    <button type="button" className="btn sm" onClick={() => void actions.removeAllowance(session.id, rule)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn sm" onClick={() => void actions.resetAllowances(session.id)}>
                Reset temporary allowances
              </button>
            </>
          )}
        </div>
      )}
    </Section>
  );
}
