import { useState } from "react";
import type { PersonaConfigView, ScheduleView, UnattendedView, WatcherView } from "@ph/shared";
import { IconPlus, IconTrash } from "./icons";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Starting points for common watchers; every field stays editable. */
const PRESETS: { label: string; w: WatcherView }[] = [
  {
    label: "GitLab MR comments",
    w: {
      name: "mr-comments",
      every: "2m",
      forEach: { tracker: { kind: "mr" } },
      get: "{{gitlabApi tracker.url}}/notes?sort=desc&per_page=50",
      items: "",
      id: "id",
      skip: { system: true },
      prompt: "New comment on {{tracker.title}} ({{tracker.url}}) from {{item.author.username}}:\n{{item.body}}\nAddress it if it asks for a change, or reply. Update the tracker.",
    },
  },
  {
    label: "GitHub PR comments",
    w: {
      name: "pr-comments",
      every: "2m",
      forEach: { tracker: { kind: "pr" } },
      get: "{{githubApi tracker.url}}/comments?per_page=50",
      items: "",
      id: "id",
      prompt: "New comment on {{tracker.title}} ({{tracker.url}}) from {{item.user.login}}:\n{{item.body}}\nAddress it if it asks for a change, or reply. Update the tracker.",
    },
  },
  {
    label: "Jira assigned to me",
    w: {
      name: "assigned-tickets",
      every: "5m",
      get: "https://jira.example.com/rest/api/3/search?jql=assignee%3DcurrentUser()%20AND%20statusCategory%3D%22To%20Do%22&fields=summary",
      items: "issues",
      id: "key",
      prompt: "A Jira ticket was assigned to you: {{item.key}} \"{{item.fields.summary}}\". Read it, track it, and say how you would approach it. Don't start the work.",
    },
  },
];

const skipText = (s?: WatcherView["skip"]) => Object.entries(s ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(", ");
function parseSkip(t: string): WatcherView["skip"] {
  const out: Record<string, string | number | boolean> = {};
  for (const part of t.split(",")) {
    const [k, ...rest] = part.split("=");
    const v = rest.join("=").trim();
    if (!k?.trim() || !v) continue;
    out[k.trim()] = v === "true" ? true : v === "false" ? false : v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
  }
  return Object.keys(out).length ? out : undefined;
}
const credText = (c: UnattendedView["credentials"]) => Object.entries(c).flatMap(([ref, rules]) => rules.map((r) => `${ref} ${r}`)).join("\n");
function parseCreds(t: string): UnattendedView["credentials"] {
  const out: UnattendedView["credentials"] = {};
  for (const line of t.split("\n")) {
    const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(line);
    if (m) (out[m[1]!] ??= []).push(m[2]!);
  }
  return out;
}

function Text({ label, value, onChange, mono, placeholder, rows }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string; rows?: number }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {rows ? (
        <textarea className={mono ? "input mono" : "input"} rows={rows} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={mono ? "input mono" : "input"} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

/** Schedules, watchers and what triggered turns may do, inside the persona's settings. */
export function TriggersEditor({ d, update }: { d: PersonaConfigView; update: (fn: (x: PersonaConfigView) => void) => void }) {
  const schedules = d.schedules ?? [];
  const watchers = d.watchers ?? [];
  const un: UnattendedView = d.unattended ?? { allow: [], credentials: {}, maxTurnsPerDay: 30 };
  const [creds, setCreds] = useState(() => credText(un.credentials));
  const [skips, setSkips] = useState<Record<number, string>>({});
  const setS = (i: number, fn: (s: ScheduleView) => void) => update((x) => fn(x.schedules![i]!));
  const setW = (i: number, fn: (w: WatcherView) => void) => update((x) => fn(x.watchers![i]!));
  const setU = (fn: (u: UnattendedView) => void) => update((x) => fn((x.unattended ??= { allow: [], credentials: {}, maxTurnsPerDay: 30 })));

  return (
    <>
      <h4>Schedules</h4>
      {schedules.map((s, i) => (
        <div key={i} className="inline-form" role="group" aria-label={`Schedule ${s.name || i + 1}`}>
          <div className="row gap">
            <div className="grow">
              <Text label="Name" mono value={s.name} placeholder="morning" onChange={(v) => setS(i, (x) => void (x.name = v))} />
            </div>
            <button type="button" className="icon-btn" aria-label={`Remove schedule ${s.name}`} onClick={() => update((x) => void x.schedules!.splice(i, 1))}>
              <IconTrash />
            </button>
          </div>
          <label className="mini-select">
            <span className="sr-only">When</span>
            <select
              value={s.once !== undefined ? "once" : s.every !== undefined ? "every" : "at"}
              onChange={(e) =>
                setS(i, (x) => {
                  const off = { at: undefined, days: undefined, every: undefined, once: undefined };
                  if (e.target.value === "every") Object.assign(x, off, { every: "1h" });
                  else if (e.target.value === "once") Object.assign(x, off, { once: `${new Date().toISOString().slice(0, 10)} 17:00` });
                  else Object.assign(x, off, { at: "09:00" });
                })
              }
            >
              <option value="at">At a time</option>
              <option value="every">Every</option>
              <option value="once">Once (a reminder)</option>
            </select>
          </label>
          {s.once !== undefined ? (
            <label className="field">
              <span className="field-label">On</span>
              <input className="input" type="datetime-local" value={s.once.replace(" ", "T")} onChange={(e) => setS(i, (x) => void (x.once = e.target.value.replace("T", " ")))} />
            </label>
          ) : s.every !== undefined ? (
            <Text label="Interval (5m, 1h, 1d)" mono value={s.every} onChange={(v) => setS(i, (x) => void (x.every = v))} />
          ) : (
            <>
              <label className="field">
                <span className="field-label">Time</span>
                <input className="input short" type="time" value={s.at ?? ""} onChange={(e) => setS(i, (x) => void (x.at = e.target.value))} />
              </label>
              <div className="row gap wrap" role="group" aria-label="Days (none: every day)">
                {DAYS.map((day) => (
                  <label key={day} className="check-row">
                    <input
                      type="checkbox"
                      checked={!!s.days?.includes(day)}
                      onChange={(e) => setS(i, (x) => void (x.days = e.target.checked ? DAYS.filter((dd) => dd === day || x.days?.includes(dd)) : (x.days ?? []).filter((dd) => dd !== day)))}
                    />
                    <span>{day[0]!.toUpperCase() + day.slice(1)}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          <Text label="Then ask the agent" rows={3} value={s.prompt} onChange={(v) => setS(i, (x) => void (x.prompt = v))} />
        </div>
      ))}
      <button type="button" className="link-btn" onClick={() => update((x) => void (x.schedules ??= []).push({ name: "", at: "09:00", days: ["mon", "tue", "wed", "thu", "fri"], prompt: "" }))}>
        <IconPlus /> Add schedule
      </button>

      <h4>Watchers</h4>
      <p className="hint">A watcher checks an API from this persona's sandbox, with its allowed hosts and credentials. The first check only records what's there. {" In a URL, use {{tracker.url}}, or {{gitlabApi tracker.url}} and {{githubApi tracker.url}} for API URLs."}</p>
      {watchers.map((w, i) => (
        <div key={i} className="inline-form" role="group" aria-label={`Watcher ${w.name || i + 1}`}>
          <div className="row gap">
            <div className="grow">
              <Text label="Name" mono value={w.name} onChange={(v) => setW(i, (x) => void (x.name = v))} />
            </div>
            <button type="button" className="icon-btn" aria-label={`Remove watcher ${w.name}`} onClick={() => update((x) => void x.watchers!.splice(i, 1))}>
              <IconTrash />
            </button>
          </div>
          <Text label="Check every (1m or more)" mono value={w.every} onChange={(v) => setW(i, (x) => void (x.every = v))} />
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!w.forEach}
              onChange={(e) => setW(i, (x) => void (x.forEach = e.target.checked ? { tracker: { kind: "mr" } } : undefined))}
            />
            <span>Once for each open tracked item</span>
          </label>
          {w.forEach && (
            <Text label="Of kind" mono value={w.forEach.tracker.kind ?? ""} placeholder="any" onChange={(v) => setW(i, (x) => void (x.forEach!.tracker.kind = v || undefined))} />
          )}
          <label className="mini-select">
            <span className="sr-only">Source</span>
            <select value={w.run ? "run" : "get"} onChange={(e) => setW(i, (x) => void (e.target.value === "run" ? Object.assign(x, { run: ["./watch.sh"], get: undefined }) : Object.assign(x, { get: "https://", run: undefined })))}>
              <option value="get">Request a URL</option>
              <option value="run">Run a command that prints JSON lines</option>
            </select>
          </label>
          {w.run ? (
            <Text label="Command" mono value={w.run.join(" ")} onChange={(v) => setW(i, (x) => void (x.run = v.split(/\s+/).filter(Boolean)))} />
          ) : (
            <>
              <Text label="URL" mono value={w.get ?? ""} onChange={(v) => setW(i, (x) => void (x.get = v))} />
              <Text label="List in the response" mono value={w.items ?? ""} placeholder="(top level)" onChange={(v) => setW(i, (x) => void (x.items = v))} />
            </>
          )}
          <div className="row gap">
            <Text label="Identified by" mono value={w.id ?? "id"} onChange={(v) => setW(i, (x) => void (x.id = v))} />
            <Text label="Changed when (optional)" mono value={w.changed ?? ""} placeholder="updated_at" onChange={(v) => setW(i, (x) => void (x.changed = v || undefined))} />
          </div>
          <Text
            label="Skip where (key=value, …)"
            mono
            value={skips[i] ?? skipText(w.skip)}
            placeholder="system=true"
            onChange={(v) => {
              setSkips((s) => ({ ...s, [i]: v }));
              setW(i, (x) => void (x.skip = parseSkip(v)));
            }}
          />
          <Text label="Then ask the agent ({{item.…}} for the new item)" rows={3} value={w.prompt} onChange={(v) => setW(i, (x) => void (x.prompt = v))} />
        </div>
      ))}
      <div className="row gap wrap">
        <button type="button" className="link-btn" onClick={() => update((x) => void (x.watchers ??= []).push({ name: "", every: "5m", get: "https://", items: "", id: "id", prompt: "" }))}>
          <IconPlus /> Add watcher
        </button>
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="link-btn" onClick={() => update((x) => void (x.watchers ??= []).push(structuredClone(p.w)))}>
            <IconPlus /> {p.label}
          </button>
        ))}
      </div>

      <h4>Unattended runs</h4>
      <p className="hint">What a turn started by a schedule or watcher may do. Anything else that would ask you is refused, and new hosts always are.</p>
      <Text
        label="Allowed without asking (one rule per line, as in Permissions)"
        mono
        rows={3}
        value={un.allow.join("\n")}
        placeholder={"read_file\nbash(git *)"}
        onChange={(v) => setU((u) => void (u.allow = v.split("\n")))}
      />
      <Text
        label="Credential rules that ask, allowed anyway (connection/CREDENTIAL rule, one per line)"
        mono
        rows={2}
        value={creds}
        placeholder="gitlab/GITLAB_TOKEN POST /api/v4/projects/*/merge_requests/*/notes"
        onChange={(v) => {
          setCreds(v);
          setU((u) => void (u.credentials = parseCreds(v)));
        }}
      />
      <label className="field">
        <span className="field-label">Triggered turns a day</span>
        <input
          className="input short"
          type="number"
          min={0}
          max={1000}
          value={un.maxTurnsPerDay}
          onChange={(e) => setU((u) => void (u.maxTurnsPerDay = Number(e.target.value || 0)))}
        />
      </label>
    </>
  );
}
