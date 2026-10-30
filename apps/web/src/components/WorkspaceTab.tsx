import { useCallback, useEffect, useState } from "react";
import type { FileEntry, PersonaSummary } from "@ph/shared";
import { api, type FileContent } from "../api";
import { cls, errorMessage, fmtBytes } from "../util";
import { IconChevronRight, IconFile, IconFolder, IconLock, IconRefresh } from "./icons";
import { CopyButton, Modal, Spinner } from "./ui";

interface DirState {
  loading: boolean;
  error?: string;
  entries?: FileEntry[];
}

export function WorkspaceTab({ persona }: { persona: PersonaSummary }) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [viewing, setViewing] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      setDirs((d) => ({ ...d, [path]: { ...d[path], loading: true, error: undefined } }));
      try {
        const res = await api.files(persona.id, path);
        const entries = [...res.entries].sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
        );
        setDirs((d) => ({ ...d, [path]: { loading: false, entries } }));
      } catch (e) {
        setDirs((d) => ({ ...d, [path]: { loading: false, error: errorMessage(e) } }));
      }
    },
    [persona.id],
  );

  const toggle = (path: string) => {
    const willOpen = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(path);
      else next.delete(path);
      return next;
    });
    if (willOpen && !dirs[path]?.entries && !dirs[path]?.loading) void load(path);
  };

  const refresh = () => {
    setDirs({});
    for (const p of expanded) void load(p);
  };

  // Expand the first mount by default.
  useEffect(() => {
    const first = persona.folders[0]?.mountPath;
    if (first) {
      setExpanded(new Set([first]));
      void load(first);
    }
  }, []);

  const renderDir = (path: string, depth: number) => {
    const d = dirs[path];
    if (!d || (d.loading && !d.entries)) {
      return (
        <div className="tree-msg" style={{ paddingLeft: 8 + depth * 14 }}>
          <Spinner size={10} /> Loading…
        </div>
      );
    }
    if (d.error) {
      return (
        <div className="tree-msg error" style={{ paddingLeft: 8 + depth * 14 }}>
          {d.error}{" "}
          <button type="button" className="link-btn" onClick={() => void load(path)}>
            Retry
          </button>
        </div>
      );
    }
    if (!d.entries?.length) {
      return (
        <div className="tree-msg muted" style={{ paddingLeft: 8 + depth * 14 }}>
          Empty
        </div>
      );
    }
    return d.entries.map((e) => (
      <div key={e.path}>
        <button
          type="button"
          className={cls("tree-row", viewing === e.path && "active")}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (e.type === "dir" ? toggle(e.path) : setViewing(e.path))}
          aria-expanded={e.type === "dir" ? expanded.has(e.path) : undefined}
          title={e.path}
        >
          {e.type === "dir" ? (
            <IconChevronRight className={cls("chev", expanded.has(e.path) && "open")} size={12} />
          ) : (
            <span className="chev-space" />
          )}
          {e.type === "dir" ? <IconFolder className="tree-icon dir" /> : <IconFile className="tree-icon" />}
          <span className="tree-name">{e.name}</span>
          {e.type === "file" && <span className="tree-size">{fmtBytes(e.size)}</span>}
        </button>
        {e.type === "dir" && expanded.has(e.path) && renderDir(e.path, depth + 1)}
      </div>
    ));
  };

  return (
    <div className="tab-pane">
      <section className="panel-section">
        <h4 className="panel-h">Mounted folders</h4>
        {persona.folders.length === 0 && <p className="muted small">No folders are mounted for this persona.</p>}
        <ul className="mounts">
          {persona.folders.map((f) => (
            <li key={f.mountPath} className="mount">
              <span className={cls("chip", f.mode === "rw" ? "mode-rw" : "mode-ro")} title={f.mode === "rw" ? "read-write" : "read-only"}>
                {f.mode === "ro" && <IconLock size={10} />}
                {f.mode}
              </span>
              <div className="mount-paths">
                <span className="mono mount-sandbox">{f.mountPath}</span>
                <span className="mono mount-host" title={f.hostPath}>
                  ← {f.hostPath}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {persona.folders.length > 0 && (
        <section className="panel-section grow">
          <div className="panel-h-row">
            <h4 className="panel-h">Files</h4>
            <button type="button" className="icon-btn sm" title="Refresh" aria-label="Refresh files" onClick={refresh}>
              <IconRefresh />
            </button>
          </div>
          <div className="tree" role="tree">
            {persona.folders.map((f) => (
              <div key={f.mountPath}>
                <button
                  type="button"
                  className="tree-row root"
                  onClick={() => toggle(f.mountPath)}
                  aria-expanded={expanded.has(f.mountPath)}
                  title={`${f.mountPath} ← ${f.hostPath}`}
                >
                  <IconChevronRight className={cls("chev", expanded.has(f.mountPath) && "open")} size={12} />
                  <IconFolder className="tree-icon dir" />
                  <span className="tree-name mono">{f.mountPath}</span>
                  <span className={cls("tree-mode", f.mode)}>{f.mode}</span>
                </button>
                {expanded.has(f.mountPath) && renderDir(f.mountPath, 1)}
              </div>
            ))}
          </div>
        </section>
      )}

      {viewing && <FileViewer personaId={persona.id} path={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function FileViewer({ personaId, path, onClose }: { personaId: string; path: string; onClose: () => void }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    api
      .file(personaId, path)
      .then((f) => alive && setFile(f))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [personaId, path]);

  const lines = file ? file.content.split("\n") : [];

  return (
    <Modal
      size="xl"
      onClose={onClose}
      title={
        <span className="viewer-title">
          <IconFile /> <span className="mono">{path}</span>
          {file && <CopyButton text={file.content} label="Copy file contents" />}
        </span>
      }
    >
      {error && <div className="form-error">{error}</div>}
      {!file && !error && (
        <div className="muted">
          <Spinner /> Loading…
        </div>
      )}
      {file && (
        <>
          {file.truncated && <div className="notice notice-warn">File is large; showing the first part only.</div>}
          <div className="viewer" tabIndex={0} aria-label={`Contents of ${path}`}>
            <pre className="viewer-gutter" aria-hidden="true">
              {lines.map((_, i) => `${i + 1}\n`).join("")}
            </pre>
            <pre className="viewer-code">{file.content}</pre>
          </div>
        </>
      )}
    </Modal>
  );
}
