import { useState, type ReactNode } from "react";
import type { ChangedFile, ChangeLine, ChangeScope } from "@ph/shared";
import { api } from "../api";
import { useSelectedPersona, useStore } from "../store";
import { cls } from "../util";
import { PaneHead } from "./Cards";
import { IconChevronDown, IconChevronRight } from "./icons";
import { useLoad } from "./MemoryUsagePane";
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

function FileChanges({ file, showFolder }: { file: ChangedFile; showFolder: boolean }) {
  const [open, setOpen] = useState(file.additions + file.deletions <= FOLD_OVER);
  const name = (p: string) => (showFolder ? `${file.folder}/${p}` : p);
  return (
    <section className="change-file">
      <button type="button" className="change-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        <span className="change-path" title={name(file.path)}>
          {file.oldPath && `${name(file.oldPath)} → `}
          {name(file.path)}
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

/** Every file the agent changed in the persona's read-write folders, stacked and foldable. */
export function ChangesPane({ onClose }: { onClose: () => void }) {
  const persona = useSelectedPersona();
  const { state } = useStore();
  const id = persona?.id ?? "";
  const [scope, setScope] = useState<ChangeScope>("conversation");
  const rev = state.changesRev[id] ?? 0;
  const { data, error } = useLoad(() => api.changes(id, scope), [id, scope, rev]);
  const report = data?.scope === scope ? data : undefined;
  const folders = new Set(report?.files.map((f) => f.folder));
  return (
    <div className="pane">
      <PaneHead
        title="Changes"
        sub={
          report?.files.length ? (
            <>
              {report.files.length} {report.files.length === 1 ? "file" : "files"} <Counts additions={report.additions} deletions={report.deletions} />
            </>
          ) : undefined
        }
        onClose={onClose}
        closeLabel="Close changes"
      >
        <label className="mini-select">
          <span className="sr-only">Compare with</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as ChangeScope)}>
            <option value="conversation">Since this conversation began</option>
            <option value="turn">Since the last message</option>
          </select>
        </label>
      </PaneHead>
      <div className="pane-body changes-body">
        {error && <p className="foot-error">{error}</p>}
        {!report && !error && <Spinner />}
        {report?.problems.map((p) => (
          <p key={p} className="small tone-attention">
            {p}
          </p>
        ))}
        {report && !report.files.length && !report.problems.length && (
          <Empty title="No changes yet">
            <p className="small muted">Files the agent changes in this persona's read-write folders appear here.</p>
          </Empty>
        )}
        {report?.files.map((f) => (
          <FileChanges key={`${f.folder}/${f.path}`} file={f} showFolder={folders.size > 1} />
        ))}
      </div>
    </div>
  );
}
