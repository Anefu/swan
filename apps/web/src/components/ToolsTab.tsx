import { useEffect, useMemo, useState } from "react";
import type { PersonaSummary, SessionSummary, ToolSummary } from "@ph/shared";
import { api } from "../api";
import { errorMessage, toolDisplayName } from "../util";
import { IconRefresh } from "./icons";
import { SourceIcon, ToolName } from "./ToolCard";
import { PermissionChip, Spinner } from "./ui";

interface Group {
  key: string;
  label: string;
  source: ToolSummary["source"];
  tools: ToolSummary[];
}

export function ToolsTab({ persona, session }: { persona: PersonaSummary; session: SessionSummary | null }) {
  const [tools, setTools] = useState<ToolSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromSession, setFromSession] = useState(false);
  const [filter, setFilter] = useState("");
  const [nonce, setNonce] = useState(0);
  const sessionId = session?.personaId === persona.id ? session.id : null;
  // MCP tools show up once the session is running; refetch when it leaves "starting".
  const sessionStarting = session?.status === "starting";

  useEffect(() => {
    let alive = true;
    setError(null);
    (async () => {
      try {
        if (sessionId) {
          try {
            const t = await api.sessionTools(sessionId);
            if (alive) {
              setTools(t);
              setFromSession(true);
            }
            return;
          } catch {
            // fall back to the persona view (e.g. session stopped)
          }
        }
        const t = await api.personaTools(persona.id);
        if (alive) {
          setTools(t);
          setFromSession(false);
        }
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [persona, sessionId, sessionStarting, nonce]);

  const groups = useMemo<Group[]>(() => {
    if (!tools) return [];
    const q = filter.trim().toLowerCase();
    const map = new Map<string, Group>();
    for (const t of tools) {
      if (q && !t.name.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) continue;
      const server = t.source === "mcp" ? (t.server ?? toolDisplayName(t.name).server ?? "mcp") : undefined;
      const key = t.source === "mcp" ? `mcp:${server}` : t.source;
      const label = t.source === "builtin" ? "Built-in" : t.source === "skill" ? "Skills" : `MCP · ${server}`;
      let g = map.get(key);
      if (!g) {
        g = { key, label, source: t.source, tools: [] };
        map.set(key, g);
      }
      g.tools.push(t);
    }
    const order = { builtin: 0, skill: 1, mcp: 2 } as const;
    return [...map.values()].sort((a, b) => order[a.source] - order[b.source] || a.label.localeCompare(b.label));
  }, [tools, filter]);

  return (
    <div className="tab-pane">
      <div className="panel-toolbar">
        <input
          className="input sm"
          placeholder="Filter tools"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter tools"
        />
        <button type="button" className="icon-btn sm" title="Refresh" aria-label="Refresh tools" onClick={() => setNonce((n) => n + 1)}>
          <IconRefresh />
        </button>
      </div>
      <p className="muted small panel-note">
        {fromSession
          ? "Tools available in this session, including MCP tools."
          : "Built-in and skill tools. MCP tools appear once a session is running."}
      </p>
      {error && <div className="form-error">{error}</div>}
      {!tools && !error && (
        <div className="muted small">
          <Spinner size={10} /> Loading tools…
        </div>
      )}
      {tools && groups.length === 0 && <p className="muted small">No tools{filter ? " match the filter" : ""}.</p>}
      {groups.map((g) => (
        <section key={g.key} className="panel-section">
          <h4 className="panel-h">
            <SourceIcon source={g.source} /> {g.label} <span className="count">{g.tools.length}</span>
          </h4>
          <ul className="tool-list">
            {g.tools.map((t) => (
              <li key={t.name} className="tool-item" title={t.description}>
                <div className="tool-item-head">
                  <ToolName name={t.name} />
                  <PermissionChip mode={t.permission} />
                </div>
                {t.description && <div className="tool-item-desc">{t.description}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
