import { useState } from "react";
import type { PersonaSummary } from "@ph/shared";
import { conversationSession, useStore } from "../../store";
import { Fold, Spinner } from "../ui";
import { Section, HostRows, listSummary, type SectionProps } from "./Section";

/** Hosts the sandbox may reach, and those approved in the conversation until stopped. */
export function HostsSection({ d, update, errors, persona, keep }: SectionProps & { persona: PersonaSummary | null; keep: (sessionId: string, rule: string) => Promise<void> }) {
  const { state, actions } = useStore();
  const [hostBusy, setHostBusy] = useState<string | null>(null);
  const session = persona ? conversationSession(state, persona.id) : null;
  const netAllowances = (session?.allowances ?? []).filter((r) => r.startsWith("net:"));
  /** Keep a host approved until stopped: save it to the persona, then drop the temporary allowance. */
  const keepHost = async (sessionId: string, rule: string) => {
    setHostBusy(rule);
    try {
      await keep(sessionId, rule);
    } finally {
      setHostBusy(null);
    }
  };
  return (
    <Section
      id="hosts"
      title="Allowed hosts"
      summary={
        d.networkAllow.length + d.networkInternal.length + netAllowances.length
          ? [
              d.networkAllow.length && listSummary(d.networkAllow, "host"),
              d.networkInternal.length && `${d.networkInternal.length} internal`,
              d.networkOtherCredentials?.length && `${d.networkOtherCredentials.length} other credentials`,
              netAllowances.length && `${netAllowances.length} until stopped`,
            ]
              .filter(Boolean)
              .join(" · ")
          : "None"
      }
      invalid={d.networkAllow.some((_, i) => errors[`host${i}`]) || d.networkInternal.some((_, i) => errors[`internal${i}`]) || (d.networkOtherCredentials ?? []).some((_, i) => errors[`other${i}`])}
    >
      <p className="hint">
        Hostnames or <span className="mono">*.domain</span>. <span className="mono">host:port</span> is always tunnelled and never
        gets credentials. Applies to the next request.
      </p>
      <Fold summary={`Public hosts · ${d.networkAllow.length}`} defaultOpen={d.networkAllow.some((_, i) => !!errors[`host${i}`])}>
      <HostRows list="networkAllow" errorKey="host" label="Host" placeholder="api.github.com" hosts={d.networkAllow} errors={errors} update={update} />
      </Fold>
      <div className="approved-hosts">
        <Fold summary={`On your company network · ${d.networkInternal.length}`} defaultOpen={d.networkInternal.some((_, i) => !!errors[`internal${i}`])}>
        <p className="hint">
          Hosts that resolve to private addresses (<span className="mono">10.x</span>, <span className="mono">172.16–31.x</span>,{" "}
          <span className="mono">192.168.x</span>), such as an internal Jira. They are allowed too. This Mac, link-local and{" "}
          <span className="mono">100.64.x</span> addresses stay unreachable.
        </p>
        <HostRows
          list="networkInternal"
          errorKey="internal"
          label="Internal host"
          placeholder="jira.corp.example.com"
          hosts={d.networkInternal}
          errors={errors}
          update={update}
        />
        </Fold>
      </div>
      <div className="approved-hosts">
        <Fold summary={`Other credentials allowed · ${(d.networkOtherCredentials ?? []).length}`} defaultOpen={(d.networkOtherCredentials ?? []).some((_, i) => !!errors[`other${i}`])}>
        <p className="hint">
          On hosts that get this persona's credentials, Swan refuses requests carrying any other credential, such as a token
          the agent found or was given. List a host here only if it needs one, like a registry token kept in a repository.
        </p>
        <HostRows
          list="networkOtherCredentials"
          errorKey="other"
          label="Host"
          placeholder="registry.corp.example.com"
          hosts={d.networkOtherCredentials ?? []}
          errors={errors}
          update={update}
        />
        </Fold>
      </div>
      {netAllowances.length > 0 && session && (
        <div className="approved-hosts">
          <Fold summary={`Approved in the conversation · ${netAllowances.length}`}>
          <p className="hint">Allowed until the agent is stopped. Keep saves the host to this persona now.</p>
          <ul className="plain-list">
            {netAllowances.map((rule) => {
              const host = rule.slice(4);
              const busy = hostBusy === rule;
              return (
                <li key={rule} className="row gap">
                  <span className="grow">
                    <span className="mono">{host}</span> <span className="muted small">· until stopped</span>
                  </span>
                  {busy && <Spinner size={10} />}
                  <button type="button" className="btn sm" disabled={!!hostBusy} onClick={() => void keepHost(session.id, rule)}>
                    Keep
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!!hostBusy}
                    onClick={async () => {
                      setHostBusy(rule);
                      await actions.removeAllowance(session.id, rule);
                      setHostBusy(null);
                    }}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          </Fold>
        </div>
      )}
    </Section>
  );
}
