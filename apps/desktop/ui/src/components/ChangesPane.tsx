import { useState, type ReactNode } from "react";
import type { ChangedFile, ChangeLine } from "@ph/shared";
import { api } from "../api";
import { useSelectedPersona, useStore } from "../store";
import { cls } from "../util";
import { PaneHead } from "./Cards";
import { IconChevronDown, IconChevronRight } from "./icons";
import { useLoad } from "../hooks";
import { Empty, Spinner } from "./ui";

const FOLD_OVER = 600; // lines; longer files start folded

export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="change-counts">
      {additions > 0 && <span className="change-add">+{additions}</span>}
      {additions > 0 && deletions > 0 && " "}
      {deletions > 0 && <span className="change-del">−{deletions}</span>}
    </span>
  );
}

/** What differs in the middle of a line, marked; the rest of the line stays plain. */
function marked(text: string, other: string | undefined): ReactNode {
  if (other === undefined || text.length > 2000 || other.length > 2000) return text;
  let start = 0;
  while (start < text.length && start < other.length && text[start] === other[start]) start++;
  let end = 0;
  while (end < text.length - start && end < other.length - start && text[text.length - 1 - end] === other[other.length - 1 - end]) end++;
  const mid = text.slice(start, text.length - end);
  // A line that changed throughout is clearer unmarked.
  if (!mid || start + end < 4) return text;
  return (
    <>
      {text.slice(0, start)}
      <span className="change-word">{mid}</span>
      {text.slice(text.length - end)}
    </>
  );
}

/** Pairs each removed line with the added line in the same place, where a run replaced as many as it added. */
function partners(lines: ChangeLine[]): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.kind !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (lines[d]?.kind === "del") d++;
    let a = d;
    while (lines[a]?.kind === "add") a++;
    if (d - i === a - d)
      for (let k = 0; k < d - i; k++) {
        out.set(i + k, lines[d + k]!.text);
        out.set(d + k, lines[i + k]!.text);
      }
    i = a;
  }
  return out;
}

function Hunk({ hunk }: { hunk: ChangedFile["hunks"][number] }) {
  const pair = partners(hunk.lines);
  return (
    <>
      <div className="change-row change-hunk">
        <span className="change-no" />
        <span className="change-no" />
        <span className="change-text">{hunk.header}</span>
      </div>
      {hunk.lines.map((l, i) => (
        <div key={i} className={cls("change-row", l.kind === "add" && "is-add", l.kind === "del" && "is-del")}>
          <span className="change-no">{l.old}</span>
          <span className="change-no">{l.new}</span>
          <span className="sr-only">{l.kind === "add" ? "added" : l.kind === "del" ? "removed" : ""}</span>
          <span className="change-text">{marked(l.text, pair.get(i))}</span>
        </div>
      ))}
    </>
  );
}

function FileChanges({ file }: { file: ChangedFile }) {
  const [open, setOpen] = useState(file.additions + file.deletions <= FOLD_OVER);
  return (
    <section className="change-file">
      <button type="button" className="change-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        <span className="change-path" title={file.path}>
          {file.oldPath && `${file.oldPath} → `}
          {file.path}
        </span>
        {file.status === "added" && <span className="muted small">new</span>}
        {file.status === "deleted" && <span className="muted small">deleted</span>}
        <Counts additions={file.additions} deletions={file.deletions} />
      </button>
      {open && (
        <div className="change-code">
          {file.binary && <p className="small muted change-note">Binary file; nothing to show.</p>}
          {file.hunks.map((h, i) => (
            <Hunk key={i} hunk={h} />
          ))}
          {file.truncated && <p className="small muted change-note">Too long to show in full.</p>}
          {!file.binary && !file.hunks.length && <p className="small muted change-note">Only its permissions or name changed.</p>}
        </div>
      )}
    </section>
  );
}

/** The diffs the agent chose to show, newest first; the pane follows the newest unless another is picked. */
export function ChangesPane({ onClose }: { onClose: () => void }) {
  const persona = useSelectedPersona();
  const { state } = useStore();
  const id = (persona && state.conversations[persona.id]) ?? "";
  const [picked, setPicked] = useState<string | null>(null);
  const rev = state.changesRev[id] ?? 0;
  const list = useLoad(() => (id ? api.diffs(id) : Promise.resolve([])), [id, rev]);
  const diffs = list.data;
  const current = diffs?.find((d) => d.id === picked) ?? diffs?.[0];
  const loaded = useLoad(() => (current ? api.diff(id, current.id) : Promise.resolve(undefined)), [id, current?.id]);
  const view = loaded.data?.id === current?.id ? loaded.data : undefined;
  const error = list.error ?? loaded.error;
  return (
    <div className="pane">
      <PaneHead
        title="Changes"
        sub={current ? <Counts additions={current.additions} deletions={current.deletions} /> : undefined}
        onClose={onClose}
        closeLabel="Close changes"
      >
        {!!diffs?.length && (
          <label className="mini-select">
            <span className="sr-only">Diff to show</span>
            <select value={current?.id} onChange={(e) => setPicked(e.target.value)}>
              {diffs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </PaneHead>
      <div className="pane-body changes-body">
        {error && <p className="foot-error">{error}</p>}
        {!error && (!diffs || (current && !view)) && <Spinner />}
        {diffs && !diffs.length && !error && (
          <Empty title="No diffs yet">
            <p className="small muted">Diffs the agent shows you appear here.</p>
          </Empty>
        )}
        {view && <p className="small muted change-command">{view.command}</p>}
        {view?.files.map((f) => (
          <FileChanges key={f.path} file={f} />
        ))}
      </div>
    </div>
  );
}
