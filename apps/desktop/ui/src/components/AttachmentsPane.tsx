import { useMemo, useState } from "react";
import type { PersonaAttachment } from "@ph/shared";
import { api, attachmentFileUrl } from "../api";
import { useSelectedPersona, useStore } from "../store";
import { useLoad } from "../hooks";
import { cls, fmtBytes, fullTime, relTime } from "../util";
import { PaneHead } from "./Cards";
import { IconExternal, IconFile, IconSearch } from "./icons";
import { Empty, Segmented, Spinner } from "./ui";

type Kind = "all" | "images" | "files";

/** Everything sent to the selected persona, newest first. */
export function AttachmentsPane({ onBack }: { onBack: () => void }) {
  const { state, actions } = useStore();
  const persona = useSelectedPersona();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [open, setOpen] = useState<string | null>(null);

  const sid = persona ? state.conversations[persona.id] : undefined;
  // Refetch when a message with attachments lands in this persona's conversation.
  const sentCount = useMemo(() => {
    const items = sid ? state.transcripts[sid]?.items : undefined;
    return (items ?? []).reduce((n, it) => n + (it.kind === "user" ? (it.attachments?.length ?? 0) : 0), 0);
  }, [sid, state.transcripts]);
  const load = useLoad<PersonaAttachment[] | null>(() => (persona ? api.personaAttachments(persona.id) : Promise.resolve(null)), [persona?.id, sentCount]);
  const list = load.data ?? null;
  const error = load.missing ? "Attachments are not available from this server yet." : load.error;
  const loading = load.loading;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter(
      (a) =>
        (kind === "all" || (kind === "images" ? a.kind === "image" : a.kind !== "image")) && (!q || a.name.toLowerCase().includes(q)),
    );
  }, [list, query, kind]);
  const images = rows.filter((a) => a.kind === "image");
  const files = rows.filter((a) => a.kind !== "image");

  return (
    <div className="pane">
      <PaneHead title="Attachments" sub={persona?.name} onBack={onBack} backLabel="Back to overview" />
      <div className="pane-tabs net-filters">
        <label className="search-field">
          <IconSearch size={16} />
          <span className="sr-only">Search attachments by name</span>
          <input placeholder="Search by name…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Segmented
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "images", label: "Images" },
            { value: "files", label: "Files" },
          ]}
        />
      </div>
      <div className="pane-body">
        {loading && !list && (
          <div className="pane-state">
            <Spinner size={14} /> Loading attachments…
          </div>
        )}
        {error && !list && <Empty title="Could not load attachments">{error}</Empty>}
        {list && rows.length === 0 && (
          <Empty title={list.length === 0 ? "Nothing attached yet" : "No attachments match"}>
            {list.length === 0 && "Attach files with the paperclip, by pasting, or by dropping them on the conversation."}
          </Empty>
        )}
        {images.length > 0 && (
          <ul className="att-grid" aria-label="Images">
            {images.map((a) => (
              <li key={`${a.sessionId}/${a.id}`}>
                <button
                  type="button"
                  className={cls("att-tile", open === a.id && "is-open")}
                  aria-expanded={open === a.id}
                  aria-label={`${a.name}, ${fmtBytes(a.size)}`}
                  title={`${a.name} · ${fmtBytes(a.size)} · ${a.sandboxPath}`}
                  onClick={() => setOpen(open === a.id ? null : a.id)}
                >
                  <img src={attachmentFileUrl(a.sessionId, a.id)} alt="" loading="lazy" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {images.some((a) => a.id === open) && <Details a={images.find((a) => a.id === open)!} personaId={persona!.id} />}
        {files.length > 0 && (
          <ul className="att-list" aria-label="Files">
            {files.map((a) => (
              <li key={`${a.sessionId}/${a.id}`} className={cls("att-list-item", open === a.id && "is-open")}>
                <button type="button" className="att-line" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                  <IconFile size={16} className="att-icon" />
                  <span className="att-text grow">
                    <span className="att-name">{a.name}</span>
                    <span className="att-meta">
                      {a.kind === "pdf" ? "PDF" : "File"} · {fmtBytes(a.size)} · <span title={fullTime(a.ts)}>{ago(a.ts)}</span>
                    </span>
                  </span>
                </button>
                {open === a.id && <Details a={a} personaId={persona!.id} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  function Details({ a, personaId }: { a: PersonaAttachment; personaId: string }) {
    return (
      <div className="att-details">
        <dl className="facts small">
          <dt>Name</dt>
          <dd>{a.name}</dd>
          <dt>Size</dt>
          <dd>{fmtBytes(a.size)}</dd>
          <dt>Sent</dt>
          <dd>{fullTime(a.ts)}</dd>
          <dt>In sandbox</dt>
          <dd className="mono">{a.sandboxPath}</dd>
        </dl>
        <div className="row gap wrap">
          <button type="button" className="btn sm" onClick={() => actions.jumpToItem(personaId, a.itemId, a.sessionId)}>
            Show in conversation
          </button>
          <a className="btn sm" href={attachmentFileUrl(a.sessionId, a.id)} target="_blank" rel="noopener noreferrer">
            Open <IconExternal size={12} />
          </a>
        </div>
      </div>
    );
  }
}

function ago(iso: string): string {
  const r = relTime(iso);
  return r === "now" ? "just now" : /^\d/.test(r) ? `${r} ago` : r;
}
