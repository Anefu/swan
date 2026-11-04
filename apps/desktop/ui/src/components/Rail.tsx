import { inRail, usePendingApprovals, useStore } from "../store";
import { cls } from "../util";
import { api } from "../api";
import { Counts } from "./ChangesPane";
import { IconDiff, IconOverview, IconSettings, IconShield, IconSwan } from "./icons";
import { useLoad } from "./MemoryUsagePane";
import { isMac } from "./ui";

/**
 * Panel buttons at the right of the header: the overview rail and the persona's settings, then
 * Swan settings. Clicking the open one closes it.
 */
export function Rail() {
  const { state, actions } = useStore();
  const approvals = usePendingApprovals();
  const dock = state.ui.dock;
  const settingsDirty = Object.values(state.drafts).some((d) => JSON.stringify(d.base) !== JSON.stringify(d.draft) || d.newId);
  const overviewOn = inRail(dock);
  const settingsOn = dock === "settings";
  const swanOn = dock === "swan";
  const settingsLabel = `Settings${settingsDirty ? " (unsaved changes)" : ""}`;
  const persona = state.selectedPersonaId;
  const changesOn = dock === "changes";
  const { data: diffs } = useLoad(() => (persona ? api.diffs(persona) : Promise.resolve(undefined)), [persona, state.changesRev[persona ?? ""] ?? 0]);
  const changes = diffs?.[0]; // the newest
  return (
    <nav className="header-tools" aria-label="Panels">
      {approvals.length > 0 && (
        <button
          type="button"
          className="rail-btn attention"
          aria-label={`${approvals.length} ${approvals.length === 1 ? "decision" : "decisions"} waiting. Review`}
          title={`${approvals.length} ${approvals.length === 1 ? "decision" : "decisions"} waiting · Review`}
          onClick={() => actions.jumpToApproval()}
        >
          <IconShield size={18} />
          <span className="rail-count">{approvals.length}</span>
        </button>
      )}
      {(changes || changesOn) && (
        <button
          type="button"
          id="trigger-changes"
          className={cls("rail-btn rail-changes", changesOn && "is-on")}
          aria-pressed={changesOn}
          aria-label={changes ? `Changes: ${changes.title}, ${changes.additions} lines added, ${changes.deletions} removed` : "Changes"}
          title="Changes"
          onClick={() => actions.openDock(changesOn ? null : "changes")}
        >
          <IconDiff size={16} />
          {changes && <Counts additions={changes.additions} deletions={changes.deletions} />}
        </button>
      )}
      <button
        type="button"
        id="trigger-overview"
        className={cls("rail-btn", overviewOn && "is-on")}
        aria-pressed={overviewOn}
        aria-label="Overview"
        title="Overview"
        disabled={!state.selectedPersonaId}
        onClick={() => actions.openDock(overviewOn ? null : "overview")}
      >
        <IconOverview size={18} />
      </button>
      <button
        type="button"
        id="trigger-settings"
        className={cls("rail-btn", settingsOn && "is-on")}
        aria-pressed={settingsOn}
        aria-label={settingsLabel}
        title={settingsLabel}
        onClick={() => {
          // Reopening shows the list of sections; a new-persona draft in progress stays open.
          if (!settingsOn) actions.setSettingsSection(null);
          actions.openDock(settingsOn ? null : "settings");
        }}
      >
        <IconSettings size={18} />
        {settingsDirty && <span className="rail-dot" aria-hidden="true" />}
      </button>
      <button
        type="button"
        id="trigger-swan"
        className={cls("rail-btn", swanOn && "is-on")}
        aria-pressed={swanOn}
        aria-label="Swan settings"
        aria-keyshortcuts={isMac ? "Meta+Comma" : "Control+Comma"}
        title={`Swan settings (${isMac ? "⌘," : "Ctrl+,"})`}
        onClick={() => actions.openDock(swanOn ? null : "swan")}
      >
        <IconSwan size={18} />
      </button>
    </nav>
  );
}
