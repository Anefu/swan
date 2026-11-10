// The frame of a settings section, and the summary line its card shows.
import { useEffect, useId, useState, type ReactNode } from "react";
import type { PersonaConfigView } from "@ph/shared";
import { useStore } from "../../store";
import { Card, CardHead, focusPaneHead } from "../Cards";
import { IconPlus, IconTrash } from "../icons";
import type { Errors } from "./config";

/** Sections that fold open inside the list; the others open on their own screen. */
/** What every section of the form gets: the draft, how to change it, and the fields that need fixing. */
export interface SectionProps {
  d: PersonaConfigView;
  update: (fn: (draft: PersonaConfigView) => void) => void;
  errors: Errors;
}

export const INLINE_SECTIONS = new Set(["folders"]);

export function HostRows({
  list,
  errorKey,
  label,
  placeholder,
  hosts,
  errors,
  update,
}: {
  list: "networkAllow" | "networkInternal" | "networkOtherCredentials";
  errorKey: string;
  label: string;
  placeholder: string;
  hosts: string[];
  errors: Errors;
  update: (fn: (x: PersonaConfigView) => void) => void;
}) {
  return (
    <>
      {hosts.map((h, i) => (
        <div key={i}>
          <div className="row gap">
            <label className="grow">
              <span className="sr-only">
                {label} {i + 1}
              </span>
              <input
                className="input mono"
                value={h}
                placeholder={placeholder}
                aria-invalid={!!errors[`${errorKey}${i}`]}
                onChange={(e) => update((x) => void (x[list][i] = e.target.value))}
              />
            </label>
            <button type="button" className="icon-btn" aria-label={`Remove ${label.toLowerCase()} ${h || i + 1}`} onClick={() => update((x) => void x[list].splice(i, 1))}>
              <IconTrash />
            </button>
          </div>
          {errors[`${errorKey}${i}`] && <span className="field-error">{errors[`${errorKey}${i}`]}</span>}
        </div>
      ))}
      <button type="button" className="link-btn" onClick={() => update((x) => void x[list].push(""))}>
        <IconPlus /> Add {label.toLowerCase()}
      </button>
    </>
  );
}

/** Remembered open inline sections, shared across personas. */
const openSections = new Set<string>(["folders"]);

export function Section({
  id,
  title,
  summary,
  children,
  invalid,
  reveal,
}: {
  id: string;
  title: string;
  summary?: string;
  children: ReactNode;
  invalid?: boolean;
  /** Changing this opens the section. */
  reveal?: number;
}) {
  const { state, actions } = useStore();
  const inline = INLINE_SECTIONS.has(id);
  const [open, setOpen] = useState(openSections.has(id) || !!invalid);
  const bodyId = useId();
  useEffect(() => {
    if (!reveal) return;
    if (!inline) {
      actions.setSettingsSection(id);
      return;
    }
    openSections.add(id);
    setOpen(true);
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps

  const opened = state.settingsSection;
  if (opened && opened !== id) return null;
  if (opened === id) {
    return (
      <div className="set-body" id={bodyId}>
        {children}
      </div>
    );
  }
  const status = invalid ? <span className="tone-error">Needs attention</span> : summary;
  if (!inline) {
    return (
      <Card line>
        <CardHead
          id={`set-${id}`}
          title={title}
          summary={status}
          onOpen={() => {
            actions.setSettingsSection(id);
            focusPaneHead();
          }}
        />
      </Card>
    );
  }
  return (
    <Card>
      <CardHead
        id={`set-${id}`}
        title={title}
        summary={status}
        open={open}
        controls={bodyId}
        onToggle={() => {
          if (open) openSections.delete(id);
          else openSections.add(id);
          setOpen(!open);
        }}
      />
      {open && (
        <div className="set-body" id={bodyId}>
          {children}
        </div>
      )}
    </Card>
  );
}

export function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

/** A card summary naming up to two things, or counting them. */
export function listSummary(names: string[], w: string) {
  return names.length <= 2 ? names.join(", ") : plural(names.length, w);
}
