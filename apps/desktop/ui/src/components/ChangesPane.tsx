import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChangedFile, ChangeLine } from "@ph/shared";
import { api } from "../api";
import { diffQuote, type DraftQuote } from "../quote";
import { useSelectedPersona, useStore } from "../store";
import { cls } from "../util";
import { PaneHead } from "./Cards";
import { IconChevronDown, IconChevronRight, IconPlus, IconX } from "./icons";
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

/** Lines being picked for a new comment: pressed on `from`, dragged to `to`, in one hunk. */
type Pick = { path: string; hunk: number; from: number; to: number };

/** What the diff's rows need to take comments. */
type Commenting = {
  comments: DraftQuote[];
  pick: Pick | null;
  onPick: (p: Pick | null) => void;
  onAdd: (p: Pick) => void;
  onReply: (id: string, reply: string) => void;
  onRemove: (id: string) => void;
};

const inRange = (i: number, a: number, b: number) => i >= Math.min(a, b) && i <= Math.max(a, b);

function Hunk({ hunk, path, index, c }: { hunk: ChangedFile["hunks"][number]; path: string; index: number; c: Commenting }) {
  const pair = partners(hunk.lines);
  const mine = c.comments.filter((q) => q.on!.path === path && q.on!.hunk === index);
  const picking = c.pick?.path === path && c.pick.hunk === index ? c.pick : null;
  return (
    <>
      <div className="change-row change-hunk">
        <span className="change-gutter" />
        <span className="change-no" />
        <span className="change-no" />
        <span className="change-text">{hunk.header}</span>
      </div>
      {hunk.lines.map((l, i) => (
        <div key={i}>
          <div
            className={cls(
              "change-row",
              l.kind === "add" && "is-add",
              l.kind === "del" && "is-del",
              (mine.some((q) => inRange(i, q.on!.from, q.on!.to)) || (picking && inRange(i, picking.from, picking.to))) && "is-commented",
            )}
            onMouseEnter={() => picking && c.onPick({ ...picking, to: i })}
          >
            <span className="change-gutter">
              <button
                type="button"
                className="change-add-comment"
                aria-label={`Comment on line ${l.new ?? l.old} of ${path}`}
                title="Comment on this line (drag for several)"
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  c.onPick({ path, hunk: index, from: i, to: i });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    c.onAdd({ path, hunk: index, from: i, to: i });
                  }
                }}
              >
                <IconPlus size={12} />
              </button>
            </span>
            <span className="change-no">{l.old}</span>
            <span className="change-no">{l.new}</span>
            <span className="sr-only">{l.kind === "add" ? "added" : l.kind === "del" ? "removed" : ""}</span>
            <span className="change-text">{marked(l.text, pair.get(i))}</span>
          </div>
          {mine
            .filter((q) => q.on!.to === i)
            .map((q) => (
              <CommentBox key={q.id} quote={q} onReply={(r) => c.onReply(q.id, r)} onRemove={() => c.onRemove(q.id)} />
            ))}
        </div>
      ))}
    </>
  );
}

/** A comment under the lines it is about. It waits in the draft and goes with your next message. */
function CommentBox({ quote, onReply, onRemove }: { quote: DraftQuote; onReply: (r: string) => void; onRemove: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const where = quote.on!.label;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [quote.reply]);
  // A new comment gets the cursor.
  useEffect(() => {
    if (!quote.reply) ref.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="change-comment">
      <textarea
        ref={ref}
        rows={2}
        value={quote.reply}
        aria-label={`Your comment on ${where}`}
        placeholder="Your comment…"
        onChange={(e) => onReply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !quote.reply.trim()) onRemove();
        }}
        // A comment left empty is dropped.
        onBlur={() => !quote.reply.trim() && onRemove()}
        spellCheck
      />
      <div className="change-comment-foot">
        <span className="small muted">Sent with your next message</span>
        <button type="button" className="icon-btn sm" aria-label={`Remove the comment on ${where}`} onMouseDown={(e) => e.preventDefault()} onClick={onRemove}>
          <IconX size={14} />
        </button>
      </div>
    </div>
  );
}

function FileChanges({ file, c }: { file: ChangedFile; c: Commenting }) {
  const [open, setOpen] = useState(file.additions + file.deletions <= FOLD_OVER || c.comments.some((q) => q.on!.path === file.path));
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
            <Hunk key={i} hunk={h} path={file.path} index={i} c={c} />
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
  const { state, actions } = useStore();
  const id = (persona && state.conversations[persona.id]) ?? "";
  const [picked, setPicked] = useState<string | null>(null);
  const rev = state.changesRev[id] ?? 0;
  const list = useLoad(() => (id ? api.diffs(id) : Promise.resolve([])), [id, rev]);
  const diffs = list.data;
  const current = diffs?.find((d) => d.id === picked) ?? diffs?.[0];
  const loaded = useLoad(() => (current ? api.diff(id, current.id) : Promise.resolve(undefined)), [id, current?.id]);
  const view = loaded.data?.id === current?.id ? loaded.data : undefined;
  const error = list.error ?? loaded.error;

  // Comments wait in the draft with quotes from the conversation, and go with the next message.
  const quotes = (persona && state.quotes[persona.id]) ?? [];
  const setQuotes = (q: DraftQuote[]) => persona && actions.setQuotes(persona.id, q);
  const [pick, setPick] = useState<Pick | null>(null);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const viewRef = useRef(view);
  viewRef.current = view;
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  // Releasing the mouse anywhere ends the pick and opens a comment on those lines; Enter on a line's button does it at once.
  const finish = (p: Pick) => {
    setPick(null);
    const file = viewRef.current?.files.find((f) => f.path === p.path);
    const lines = file?.hunks[p.hunk]?.lines;
    if (!viewRef.current || !lines) return;
    const from = Math.min(p.from, p.to);
    const to = Math.max(p.from, p.to);
    const { label, text } = diffQuote(p.path, lines.slice(from, to + 1));
    setQuotes([...quotesRef.current, { id: crypto.randomUUID(), text, reply: "", on: { diffId: viewRef.current.id, path: p.path, hunk: p.hunk, from, to, label } }]);
  };
  useEffect(() => {
    if (!pick) return;
    const up = () => pickRef.current && finish(pickRef.current);
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, [!!pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const commenting: Commenting = {
    comments: quotes.filter((q) => q.on && q.on.diffId === view?.id),
    pick,
    onPick: (p) => setPick(p),
    onAdd: finish,
    onReply: (id, reply) => setQuotes(quotesRef.current.map((q) => (q.id === id ? { ...q, reply } : q))),
    onRemove: (id) => setQuotes(quotesRef.current.filter((q) => q.id !== id)),
  };
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
          <FileChanges key={f.path} file={f} c={commenting} />
        ))}
      </div>
    </div>
  );
}
