import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { PersonaSummary, SessionSummary } from "@ph/shared";
import { api } from "../api";
import { agentLive, describeTool, type ToolItem } from "../receipts";
import { conversationSession, useSelectedPersona, useStore, type DockMode } from "../store";
import { personaModelLine, plural } from "../status";
import { fmtDuration, relTime, useNow } from "../util";
import { Card, CardHead, focusPaneHead, MeterSm } from "./Cards";
import { IconBox, IconCheck, IconFile, IconFolder, IconImage, IconSparkles } from "./icons";
import { useLoad } from "./MemoryUsagePane";
import { Empty, Spinner } from "./ui";

/** Remembered folded cards, shared across personas. */
const folded = new Set<string>();

/** The last value each card loaded, so coming back to the overview shows it while it refreshes. */
const lastLoaded = new Map<string, unknown>();

function useCardData<T>(key: string, fn: () => Promise<T>, deps: unknown[]): T | undefined {
  const { data } = useLoad(fn, deps);
  if (data !== undefined) lastLoaded.set(key, data);
  return (data ?? lastLoaded.get(key)) as T | undefined;
}

function useFold(id: string): [boolean, () => void] {
  const [open, setOpen] = useState(!folded.has(id));
  return [
    open,
    () => {
      if (open) folded.add(id);
      else folded.delete(id);
      setOpen(!open);
    },
  ];
}

/** The rail's first screen: what the selected persona is working with, one card per thing, each leading to its detail. */
export function OverviewPane() {
  const persona = useSelectedPersona();
  if (!persona) {
    return (
      <div className="pane">
        <div className="pane-body">
          <Empty title="No persona selected" />
        </div>
      </div>
    );
  }
  return (
    <div className="pane">
      <h2 className="sr-only">Overview of {persona.name}</h2>
      <div className="pane-body rail-cards">
        <PersonaCard persona={persona} />
        <ContextCard persona={persona} />
        <AgentsCard persona={persona} />
        <ConnectionsCard persona={persona} />
        <MemoryCard persona={persona} />
        <AttachmentsCard persona={persona} />
        <NetworkCard persona={persona} />
      </div>
    </div>
  );
}

/** Open a screen of the rail; its back button returns focus to the card with id `ov-<mode>`. */
function useOpen() {
  const { actions } = useStore();
  return (mode: DockMode) => {
    actions.openDock(mode);
    focusPaneHead();
  };
}

function Row({ icon, children, end }: { icon?: ReactNode; children: ReactNode; end?: ReactNode }) {
  return (
    <div className="rcard-row">
      {icon}
      <span className="grow">{children}</span>
      {end !== undefined && <span className="end">{end}</span>}
    </div>
  );
}

function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function sandboxState(session: SessionSummary | null, available: boolean | undefined): { text: string; tone?: string } {
  if (available === false) return { text: "Unavailable", tone: "tone-error" };
  switch (session?.status) {
    case undefined:
      return { text: "Not started" };
    case "starting":
      return { text: "Starting" };
    case "error":
      return { text: "Error", tone: "tone-error" };
    case "stopped":
      return { text: "Stopped" };
    default:
      return { text: "Running", tone: "tone-ok" };
  }
}

function PersonaCard({ persona }: { persona: PersonaSummary }) {
  const { state } = useStore();
  const [open, toggle] = useFold("persona");
  const bodyId = useId();
  const session = conversationSession(state, persona.id);
  // Named by where the sandbox sees them, as Settings names them.
  const names = persona.folders.map((f) => folderName(f.mountPath));
  const canChange = persona.folders.filter((f) => f.mode === "rw").length;
  const sandbox = sandboxState(session, state.runtime?.available);
  return (
    <Card>
      <CardHead title="Persona" open={open} onToggle={toggle} controls={bodyId} summary={open ? undefined : persona.name} />
      {open && (
        <div className="rcard-rows" id={bodyId}>
          <Row icon={<IconSparkles size={16} />} end={persona.model.provider}>
            {personaModelLine(state, persona)}
          </Row>
          <Row
            icon={<IconFolder size={16} />}
            end={names.length ? (canChange ? `${canChange} can change` : "Read only") : undefined}
          >
            {names.length ? (
              <span className="mono">{names.length > 2 ? `${names.slice(0, 2).join(" · ")} +${names.length - 2}` : names.join(" · ")}</span>
            ) : (
              <span className="muted">No folders</span>
            )}
          </Row>
          <Row icon={<IconBox size={16} />} end={<span className={sandbox.tone}>{sandbox.text}</span>}>
            Sandbox
          </Row>
        </div>
      )}
    </Card>
  );
}

function ContextCard({ persona }: { persona: PersonaSummary }) {
  const { state } = useStore();
  const open = useOpen();
  const rev = state.usageRev[persona.id] ?? 0;
  const data = useCardData(`usage:${persona.id}`, () => api.usage(persona.id, "today"), [persona.id, rev]);
  const c = data?.context;
  const pct = c && c.limitTokens > 0 ? (c.usedTokens / c.limitTokens) * 100 : null;
  return (
    <Card line>
      <CardHead
        id="ov-usage"
        title="Context"
        onOpen={() => open("usage")}
        summary={
          pct === null ? (
            data ? "Not started" : ""
          ) : (
            <>
              {Math.round(pct)}%
              <MeterSm pct={pct} label="Context used" />
            </>
          )
        }
      />
    </Card>
  );
}

function AgentsCard({ persona }: { persona: PersonaSummary }) {
  const { state, actions } = useStore();
  const [open, toggle] = useFold("agents");
  const bodyId = useId();
  const session = conversationSession(state, persona.id);
  const items = session ? state.transcripts[session.id]?.items : undefined;
  const agents = useMemo(() => (items ?? []).filter((it): it is ToolItem => it.kind === "tool_call" && !!it.agent), [items]);
  const live = agents.filter(agentLive);
  const now = useNow(live.length ? 1000 : 60_000);
  const [stopping, setStopping] = useState<string | null>(null);
  if (!session || agents.length === 0) return null;
  const finished = agents.length - live.length;
  return (
    <Card>
      <CardHead
        title="Agents"
        open={open}
        onToggle={toggle}
        controls={bodyId}
        summary={open ? undefined : live.length ? `${live.length} running` : `${finished} finished`}
      />
      {open && (
        <div className="rcard-rows" id={bodyId}>
          {live.map((it) => {
            const a = it.agent!;
            const what = describeTool(it).target || a.name;
            return (
              <div className="rcard-row" key={it.id}>
                <Spinner size={12} />
                <button type="button" className="rcard-link grow" onClick={() => actions.jumpToItem(persona.id, it.id)}>
                  {what}
                </button>
                <span className="end">{a.state === "asking" ? "asking" : fmtDuration(now - Date.parse(a.startedAt))}</span>
                <button
                  type="button"
                  className="link-btn small"
                  disabled={stopping === a.id}
                  aria-label={`Stop the agent ${what}`}
                  onClick={async () => {
                    setStopping(a.id);
                    await actions.stopAgent(session.id, a.id);
                    setStopping(null);
                  }}
                >
                  Stop
                </button>
              </div>
            );
          })}
          {finished > 0 && (
            <Row icon={<IconCheck size={16} />}>
              <span className="muted">{finished} finished</span>
            </Row>
          )}
        </div>
      )}
    </Card>
  );
}

function ConnectionsCard({ persona }: { persona: PersonaSummary }) {
  const { state, actions } = useStore();
  const used = state.connections.filter((c) => persona.connections.includes(c.name));
  const waiting = used.filter((c) => c.state !== "ready").length;
  const summary = !persona.connections.length ? (
    "None"
  ) : waiting ? (
    <span className="tone-attention">{waiting === 1 ? "1 needs attention" : `${waiting} need attention`}</span>
  ) : (
    `${used.length} ready`
  );
  return (
    <Card line>
      <CardHead id="ov-connections" title="Connections" summary={summary} onOpen={() => {
          actions.openSettings({ section: "connections" });
          focusPaneHead();
        }}
      />
    </Card>
  );
}

function MemoryCard({ persona }: { persona: PersonaSummary }) {
  const { state } = useStore();
  const open = useOpen();
  const rev = state.memoryRev[persona.id] ?? 0;
  const data = useCardData(`memory:${persona.id}`, () => api.memory(persona.id), [persona.id, rev]);
  return (
    <Card line>
      <CardHead id="ov-memory" title="Memory" summary={data ? (data.length ? `${data.length} saved` : "None yet") : ""} onOpen={() => open("memory")} />
    </Card>
  );
}

function AttachmentsCard({ persona }: { persona: PersonaSummary }) {
  const { state } = useStore();
  const open = useOpen();
  const [unfolded, toggle] = useFold("attachments");
  const bodyId = useId();
  const now = useNow();
  const sid = state.conversations[persona.id];
  // Refetch when a message with attachments lands in this persona's conversation.
  const sent = useMemo(() => {
    const items = sid ? state.transcripts[sid]?.items : undefined;
    return (items ?? []).reduce((n, it) => n + (it.kind === "user" ? (it.attachments?.length ?? 0) : 0), 0);
  }, [sid, state.transcripts]);
  const data = useCardData(`attachments:${persona.id}`, () => api.personaAttachments(persona.id), [persona.id, sent]);
  const list = data ?? [];
  if (list.length === 0) {
    return (
      <Card line>
        <CardHead id="ov-attachments" title="Attachments" summary={data ? "None yet" : ""} onOpen={() => open("attachments")} />
      </Card>
    );
  }
  return (
    <Card>
      {/* Same id as the one-line card, so focus coming back from Attachments survives the list arriving. */}
      <CardHead
        id="ov-attachments"
        title="Attachments"
        open={unfolded}
        onToggle={toggle}
        controls={bodyId}
        summary={unfolded ? undefined : String(list.length)}
      />
      {unfolded && (
        <div className="rcard-rows" id={bodyId}>
          {list.slice(0, 2).map((a) => (
            <Row key={a.id} icon={a.kind === "image" ? <IconImage size={16} /> : <IconFile size={16} />} end={relTime(a.ts, now)}>
              {a.name}
            </Row>
          ))}
          <button type="button" className="link-btn rcard-more" onClick={() => open("attachments")}>
            {list.length > 2 ? `Show all ${list.length}` : "Open attachments"}
          </button>
        </div>
      )}
    </Card>
  );
}

function NetworkCard({ persona }: { persona: PersonaSummary }) {
  const { state, actions } = useStore();
  const open = useOpen();
  useEffect(() => {
    void actions.refreshEgress();
  }, [actions]);
  const { total, blocked } = useMemo(() => {
    const sessions = new Set(Object.values(state.sessions).filter((s) => s.personaId === persona.id).map((s) => s.id));
    let total = 0;
    let blocked = 0;
    for (const e of state.egress) {
      if (e.personaId !== persona.id && !(e.sessionId && sessions.has(e.sessionId))) continue;
      total += 1;
      if (e.decision === "blocked") blocked += 1;
    }
    return { total, blocked };
  }, [state.egress, state.sessions, persona.id]);
  return (
    <Card line>
      <CardHead
        id="ov-network"
        title="Network"
        onOpen={() => open("network")}
        summary={
          total ? (
            <span>
              {plural(total, "request")}
              {blocked > 0 && <span className="tone-attention"> · {blocked} blocked</span>}
            </span>
          ) : (
            "No requests"
          )
        }
      />
    </Card>
  );
}
