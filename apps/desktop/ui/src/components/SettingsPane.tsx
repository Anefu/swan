import type { PersonaSummary } from "@ph/shared";
import { NEW_PERSONA, useSelectedPersona, useStore, type SettingsDraft } from "../store";
import { cls } from "../util";
import { PaneHead } from "./Cards";
import { TriggersEditor } from "./TriggersEditor";
import { Empty, Spinner } from "./ui";
import { ConnectionsSection } from "./settings/ConnectionsSection";
import { Folders } from "./settings/Folders";
import { HostsSection } from "./settings/HostsSection";
import { MemorySection } from "./settings/MemorySection";
import { NameSection } from "./settings/NameSection";
import { DeletePersona, ExportPersona } from "./settings/PersonaActions";
import { PermissionsSection } from "./settings/PermissionsSection";
import { plural, Section } from "./settings/Section";
import { SubagentsSection } from "./settings/SubagentsSection";
import { ToolsSection } from "./settings/ToolsSection";
import { usePersonaDraft } from "./settings/usePersonaDraft";

/** Section titles, for the head of a section opened from the list. */
const SECTION_TITLE: Record<string, string> = {
  name: "Name and instructions",
  folders: "Folders",
  hosts: "Allowed hosts",
  connections: "Connections",
  permissions: "Permissions",
  subagents: "Sub-agents",
  triggers: "Schedules and watchers",
  tools: "MCP servers and skills",
  memory: "Memory brief",
};


/**
 * Settings of the selected persona (or the new-persona draft), as a list of cards. A card opens its section on its own
 * screen with a way back; edits from every section collect in one draft and save together. Swan's own settings have their own pane.
 */
export function SettingsPane() {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const subject = state.settingsNew ? "New persona" : persona?.name;
  const opened = state.settingsSection && SECTION_TITLE[state.settingsSection] ? state.settingsSection : null;
  const back = () => {
    actions.setSettingsSection(null);
    window.setTimeout(() => document.getElementById(`set-${opened}`)?.focus(), 0);
  };
  return (
    <div className="pane">
      <PaneHead
        title={opened ? SECTION_TITLE[opened] : "Settings"}
        sub={subject}
        onBack={opened ? back : undefined}
        backLabel="Back to settings"
      />
      {state.settingsNew ? (
        <PersonaSettings key={NEW_PERSONA} draftKey={NEW_PERSONA} persona={null} />
      ) : persona ? (
        <PersonaSettings key={persona.id} draftKey={persona.id} persona={persona} />
      ) : (
        <div className="pane-body">
          <Empty
            title="No persona yet"
            action={
              <button type="button" className="btn primary" onClick={() => actions.openSettings({ isNew: true })}>
                Create a persona
              </button>
            }
          >
            A persona sets the folders, hosts, credentials and rules the agent works with.
          </Empty>
        </div>
      )}
    </div>
  );
}

function PersonaSettings({ draftKey, persona }: { draftKey: string; persona: PersonaSummary | null }) {
  const { state } = useStore();
  const { entry, isNew, loading, loadError, load, saving, save, discard, update, keepHost, errors, errorCount, dirty, newId, setNewId, newModel, setNewModel, mcp, foldersSeq, reveal } =
    usePersonaDraft(draftKey, persona);
  if (!entry) {
    return (
      <div className="pane-body">
        {loading || !loadError ? (
          <div className="pane-state">
            <Spinner size={14} /> Loading settings…
          </div>
        ) : (
          <Empty
            title="Settings unavailable"
            action={
              <button type="button" className="btn" onClick={() => void load()}>
                Try again
              </button>
            }
          >
            {loadError}
          </Empty>
        )}
      </div>
    );
  }
  const d = entry.draft;

  return (
    <>
      {/* Keyed by the open section, so each screen starts at the top. */}
      <div className={cls("pane-body", !state.settingsSection && "rail-cards")} key={state.settingsSection ?? "list"}>
        <NameSection d={d} update={update} errors={errors} isNew={isNew} newId={newId} onNewId={setNewId} newModel={newModel} onNewModel={setNewModel} />

        <Section
          id="folders"
          title="Folders"
          summary={d.folders.length ? String(d.folders.length) : "None"}
          invalid={d.folders.some((_, i) => errors[`folder${i}`])}
        >
          <Folders key={foldersSeq} folders={d.folders} errors={errors} update={update} />
        </Section>

        <HostsSection d={d} update={update} errors={errors} persona={persona} keep={keepHost} />

        <ConnectionsSection d={d} update={update} errors={errors} persona={persona} reveal={reveal} />

        <PermissionsSection d={d} update={update} persona={persona} />

        <SubagentsSection d={d} update={update} errors={errors} />

        {d.schedules && (
          <Section
            id="triggers"
            title="Schedules and watchers"
            summary={`${plural(d.schedules.length, "schedule")}, ${plural(d.watchers?.length ?? 0, "watcher")}`}
          >
            <TriggersEditor d={d} update={update} />
          </Section>
        )}

        <ToolsSection d={d} update={update} errors={errors} mcp={mcp} />

        <MemorySection d={d} update={update} errors={errors} />
        {!isNew && persona && !state.settingsSection && (
          <div className="row gap wrap">
            <ExportPersona persona={persona} />
            <DeletePersona persona={persona} />
          </div>
        )}
      </div>

      <div className="pane-foot" aria-live="polite">
        {entry.error && (
          <p className="foot-error" role="alert">
            Not saved: {entry.error}
          </p>
        )}
        {!dirty && entry.result && <SaveSummary result={entry.result} />}
        {dirty && entry.outdated && (
          <p className="small tone-attention" role="status">
            This persona changed elsewhere while you were editing (for example “Always allow” on a request). Saving replaces those
            changes; Discard shows them.
          </p>
        )}
        {dirty && (
          <div className="row gap">
            <span className="grow tone-attention">
              {errorCount > 0 ? `Fix ${plural(errorCount, "field")} to save` : isNew ? "New persona, not saved" : "Unsaved changes"}
            </span>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving || errorCount > 0}>
              {saving && <Spinner size={12} />}
              {isNew ? "Create persona" : "Save changes"}
            </button>
            <button type="button" className="btn" onClick={discard} disabled={saving}>
              Discard
            </button>
          </div>
        )}
        {!dirty && !entry.result && <span className="muted small">All changes saved.</span>}
      </div>
    </>
  );
}

function SaveSummary({ result }: { result: NonNullable<SettingsDraft["result"]> }) {
  const { state } = useStore();
  // Use the live persona, so a problem fixed since the save is not shown.
  const live = state.personas.find((p) => p.id === result.persona.id) ?? result.persona;
  return (
    <div className="save-summary">
      <p>
        <strong>Saved.</strong>
        {result.appliedNow.length > 0 && ` Applied now: ${result.appliedNow.join(", ")}.`}
        {result.nextStart.length > 0 && ` Applied later: ${result.nextStart.join(", ")}.`}
      </p>
      {(result.notes ?? []).map((n, i) => (
        <p key={i} className="muted">
          {n}
        </p>
      ))}
      {live.errors.length > 0 && (
        <p className="tone-attention">
          Still to fix before {live.name} can start: {live.errors.join("; ")}
        </p>
      )}
    </div>
  );
}
