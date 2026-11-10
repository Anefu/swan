// The connections a persona uses, and the rules for each of its credentials.
import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus, CredentialRule, RuleApi } from "@ph/shared";
import { useStore } from "../../store";
import { CONNECTION_STATE, RULE_API_LABEL, RULE_APIS, RULE_PRESETS } from "../../status";
import { clone, sameJson } from "../../util";
import { IconPlus, IconTrash } from "../icons";
import { Field, Fold } from "../ui";
import { patterns, type Errors } from "./config";

const CUSTOM = "\u0001custom";

const PATTERN_HINT: Record<RuleApi, string> = {
  kubernetes: "verb resource[/sub] [in namespace], e.g. get pods in payments",
  aws: "service:Action, e.g. s3:GetObject or logs:Describe*",
  http: "METHOD /path, with * for one segment and ** for any, e.g. GET /repos/**",
};

export function newRule(c: ConnectionStatus | undefined, credential?: string): CredentialRule {
  const name = credential ?? c?.credentials[0]?.name ?? "*";
  const kind = c?.credentials.find((x) => x.name === name)?.kind;
  return { credential: name, api: kind === "aws-sigv4" ? "aws" : "http", allow: [], ask: [], deny: [] };
}

export function AddConnection({ used, onAdd }: { used: string[]; onAdd: (c: ConnectionStatus) => void }) {
  const { state, actions } = useStore();
  const free = state.connections.filter((c) => !used.includes(c.name));
  if (state.connections.length === 0)
    return (
      <p className="muted small">
        No connections yet. Add credentials in{" "}
        <button type="button" className="link-btn inline" onClick={actions.openSwanSettings}>
          Swan settings
        </button>
        .
      </p>
    );
  if (free.length === 0) return null;
  return (
    <label>
      <span className="sr-only">Add connection</span>
      <select
        className="input"
        value=""
        onChange={(e) => {
          const c = free.find((x) => x.name === e.target.value);
          if (c) onAdd(c);
        }}
      >
        <option value="">Add connection…</option>
        {free.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} · {c.type}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ConnectionRules({
  name,
  rules,
  status,
  errors,
  onChange,
  onRemove,
}: {
  name: string;
  rules: CredentialRule[];
  status: ConnectionStatus | undefined;
  errors: Errors;
  onChange: (fn: (rules: CredentialRule[]) => void) => void;
  onRemove: () => void;
}) {
  const st = status ? CONNECTION_STATE[status.state] : null;
  return (
    <div className="folder-row conn-card">
      <div className="row gap">
        <span className="grow">
          <span className="mono strong">{name}</span>
          {status && st && (
            <span className="muted small">
              {" "}
              · {status.type} · <span className={st.tone === "ok" ? undefined : `tone-${st.tone}`}>{st.label}</span>
            </span>
          )}
        </span>
        <button type="button" className="icon-btn" aria-label={`Remove connection ${name}`} onClick={onRemove}>
          <IconTrash />
        </button>
      </div>
      {!status && <span className="field-error">Not defined in config.yaml; these rules do nothing.</span>}
      {rules.length === 0 && <p className="muted small">No rules: requests go out without these credentials.</p>}
      <Fold summary={`${rules.length} ${rules.length === 1 ? "rule" : "rules"}`} defaultOpen={rules.length === 0 || !!Object.keys(errors).some((k) => k.startsWith(`rule-${name}-`))}>
      {rules.map((r, i) => (
        <RuleEditor
          key={i}
          id={`rule-${name}-${i}`}
          rule={r}
          status={status}
          error={errors[`rule-${name}-${i}`]}
          onChange={(fn) => onChange((rs) => fn(rs[i]))}
          onRemove={() => onChange((rs) => void rs.splice(i, 1))}
        />
      ))}
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          const next = status?.credentials.find((c) => !rules.some((r) => r.credential === c.name))?.name ?? "*";
          onChange((rs) => void rs.push(newRule(status, next)));
        }}
      >
        <IconPlus /> Add rule
      </button>
      </Fold>
    </div>
  );
}

function RuleEditor({
  id,
  rule,
  status,
  error,
  onChange,
  onRemove,
}: {
  id: string;
  rule: CredentialRule;
  status: ConnectionStatus | undefined;
  error?: string;
  onChange: (fn: (r: CredentialRule) => void) => void;
  onRemove: () => void;
}) {
  const names = status?.credentials.map((c) => c.name) ?? [];
  const known = rule.credential === "*" || names.includes(rule.credential);
  const [custom, setCustom] = useState(!known);
  const showInput = custom || !known;
  const label = rule.credential || "new rule";
  const presets = RULE_PRESETS[rule.api];
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (custom && known) inputRef.current?.focus();
  }, [custom]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="rule-edit" id={id}>
      <div className="row gap wrap">
        <label>
          <span className="sr-only">Credential for rule {label}</span>
          <select
            className="input"
            value={showInput ? CUSTOM : rule.credential}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM) setCustom(true);
              else {
                setCustom(false);
                onChange((r) => void (r.credential = v));
              }
            }}
          >
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value="*">Every credential (*)</option>
            <option value={CUSTOM}>Name or pattern…</option>
          </select>
        </label>
        <label>
          <span className="sr-only">API for rule {label}</span>
          <select className="input" value={rule.api} onChange={(e) => onChange((r) => void (r.api = e.target.value as RuleApi))}>
            {RULE_APIS.map((a) => (
              <option key={a} value={a}>
                {RULE_API_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Apply a preset to rule {label}</span>
          <select
            className="input"
            value=""
            onChange={(e) => {
              const p = presets[e.target.value];
              if (p) onChange((r) => Object.assign(r, clone(p)));
            }}
          >
            <option value="">Preset…</option>
            {Object.keys(presets).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>
      {showInput && (
        <label>
          <span className="sr-only">Credential name or pattern for rule {label}</span>
          <input
            ref={inputRef}
            className="input mono sm"
            value={rule.credential}
            placeholder="name, or a pattern like prod-*"
            spellCheck={false}
            aria-invalid={!!error}
            onChange={(e) => onChange((r) => void (r.credential = e.target.value))}
          />
        </label>
      )}
      {error && <span className="field-error">{error}</span>}
      {(["allow", "ask", "deny"] as const).map((k) => {
        const list = rule[k] ?? [];
        return (
          <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)}`}>
            {(f) => (
              <textarea
                {...f}
                className="input mono"
                rows={Math.min(8, list.length + 1)}
                value={list.join("\n")}
                spellCheck={false}
                onChange={(e) => onChange((r) => void (r[k] = e.target.value.split("\n")))}
                onBlur={() => {
                  const clean = patterns(list);
                  if (!sameJson(clean, list)) onChange((r) => void (r[k] = clean));
                }}
              />
            )}
          </Field>
        );
      })}
      <div className="row gap">
        <p className="hint grow">One pattern per line: {PATTERN_HINT[rule.api]}.</p>
        <button type="button" className="link-btn line-action" aria-label={`Remove rule ${label}`} onClick={onRemove}>
          Remove rule
        </button>
      </div>
    </div>
  );
}
