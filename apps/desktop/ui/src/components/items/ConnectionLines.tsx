// Sign-ins and requests that went out without a credential.
import { useState } from "react";
import type { ChatItem, PersonaSummary } from "@ph/shared";
import { useStore } from "../../store";
import { cls } from "../../util";
import { DeviceCodePanel } from "../DeviceCode";
import { IconChevronRight } from "../icons";

/** A command connection needs a sign-in. The code is for the user; the agent never sees it. */
export function SignInCard({ item }: { item: Extract<ChatItem, { kind: "sign_in" }> }) {
  const { actions } = useStore();
  const [busy, setBusy] = useState(false);
  const active = item.state === "starting" || item.state === "waiting";
  if (!active) {
    const failed = item.state === "failed";
    const text =
      item.state === "done"
        ? `Signed in to ${item.connection}`
        : item.state === "cancelled"
          ? `Sign-in to ${item.connection} cancelled`
          : `Sign-in to ${item.connection} failed${item.message ? `: ${item.message}` : ""}`;
    return (
      <div className="line-item" id={`item-${item.id}`}>
        <div className="line static">
          <span className={cls("glyph", failed ? "tone-error" : item.state === "done" ? "tone-ok" : "tone-muted")} aria-hidden="true">
            {failed ? "!" : item.state === "done" ? "●" : "◌"}
          </span>
          <span className="line-target plain">{text}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="line-item is-pending" id={`item-${item.id}`}>
      <div className="line static">
        <span className="glyph tone-attention" aria-hidden="true">
          ●
        </span>
        <span className="line-verb">Sign in to {item.connection}</span>
      </div>
      <div className="prompt" role="group" aria-label={`Sign in to ${item.connection}`}>
        <DeviceCodePanel
          code={item.state === "waiting" ? (item.code ?? null) : null}
          busy={busy}
          onCancel={async () => {
            setBusy(true);
            await actions.connectionAction(item.connection, "cancel");
            setBusy(false);
          }}
        />
      </div>
    </div>
  );
}

/** Requests that went out without a credential because no rule allowed them. */
export function CredentialBlockedLine({
  item,
  persona,
}: {
  item: Extract<ChatItem, { kind: "credential_blocked" }>;
  persona: PersonaSummary | null;
}) {
  const { actions } = useStore();
  const [open, setOpen] = useState(false);
  const latest = item.operations[item.operations.length - 1] ?? "";
  const others = item.operations.slice(0, -1).reverse();
  const slash = item.credential.indexOf("/");
  const connection = item.credential.slice(0, slash);
  const name = item.credential.slice(slash + 1);
  const body = (
    <>
      <span className="glyph tone-attention" aria-hidden="true">
        ⊘
      </span>
      <span className="line-verb">Blocked</span>
      <span className="line-target mono">{latest}</span>
      <span className="line-meta">
        with {item.credential}: {item.rule ? `rule "${item.rule}"` : "no rule"}
        {item.count > 1 && ` · ×${item.count}`}
      </span>
    </>
  );
  return (
    <div className="line-item" id={`item-${item.id}`}>
      <div className="row gap">
        {others.length > 0 ? (
          <button type="button" className="line grow" aria-expanded={open} onClick={() => setOpen(!open)}>
            {body}
            <IconChevronRight className="chev" size={14} />
          </button>
        ) : (
          <div className="line static grow">{body}</div>
        )}
        {persona && (
          <button
            type="button"
            className="link-btn line-action"
            title={`Opens Settings with an allow rule for ${item.suggestion}`}
            aria-label={`Add rule allowing ${item.suggestion} with ${item.credential}`}
            onClick={() =>
              actions.addRuleInSettings(persona.id, connection, { credential: name, api: item.api, allow: [item.suggestion], ask: [], deny: [] })
            }
          >
            Add rule…
          </button>
        )}
      </div>
      {open && (
        <div className="line-detail">
          <span className="small muted">Also sent without the credential:</span>
          <ul className="plain-list small mono">
            {others.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
