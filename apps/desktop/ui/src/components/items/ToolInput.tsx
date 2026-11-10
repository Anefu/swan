// What a tool call was given: its command, file edit, diff or arguments.
import type { ReactNode } from "react";
import { str, type ToolItem } from "../../receipts";
import { cls, isRecord, prettyJson, toolDisplayName } from "../../util";
import { CopyButton } from "../ui";

export function Section({ label, copy, children }: { label: string; copy?: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-label">
        <span>{label}</span>
        {copy ? <CopyButton text={copy} label={`Copy ${label.toLowerCase()}`} /> : null}
      </div>
      {children}
    </div>
  );
}

/** Line diff: common leading/trailing lines become context. */
export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const rows: Array<{ sign: " " | "-" | "+"; text: string }> = [];
  for (let i = Math.max(0, pre - 2); i < pre; i++) rows.push({ sign: " ", text: a[i] });
  for (let i = pre; i < a.length - suf; i++) rows.push({ sign: "-", text: a[i] });
  for (let i = pre; i < b.length - suf; i++) rows.push({ sign: "+", text: b[i] });
  for (let i = a.length - suf; i < Math.min(a.length, a.length - suf + 2); i++) rows.push({ sign: " ", text: a[i] });
  return (
    <pre className="code diff" aria-label="Proposed change">
      {rows.map((r, i) => (
        <span key={i} className={cls("diff-line", r.sign === "-" ? "del" : r.sign === "+" ? "add" : "ctx")}>
          <span className="diff-sign" aria-label={r.sign === "-" ? "removed" : r.sign === "+" ? "added" : undefined}>
            {r.sign}
          </span>
          {r.text || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export function ToolInput({ item }: { item: ToolItem }) {
  const tool = toolDisplayName(item.name).tool;
  const input = item.input;
  if (isRecord(input) && !toolDisplayName(item.name).server) {
    const path = str(input, ["path", "file_path", "filePath", "file"]);
    if (tool === "bash") {
      const cmd = str(input, ["command", "cmd"]);
      if (cmd)
        return (
          <Section label="Command" copy={cmd}>
            <pre className="code">
              <span className="sh-prompt" aria-hidden="true">
                ${" "}
              </span>
              {cmd}
            </pre>
          </Section>
        );
    }
    if (tool === "agent_message") {
      const m = str(input, ["message"]);
      if (m !== null)
        return (
          <Section label="Message" copy={m}>
            <pre className="code-plain">{m}</pre>
          </Section>
        );
    }
    if (tool === "edit_file") {
      const o = str(input, ["old_string"]);
      const n = str(input, ["new_string"]);
      if (o !== null || n !== null)
        return (
          <Section label={path ?? "Change"}>
            <DiffView oldText={o ?? ""} newText={n ?? ""} />
          </Section>
        );
    }
    if (tool === "write_file") {
      const c = str(input, ["content"]);
      if (c !== null) {
        const lines = c.split("\n");
        const shown = lines.slice(0, 200);
        return (
          <Section label={path ?? "New content"} copy={c}>
            <pre className="code diff">
              {shown.map((l, i) => (
                <span key={i} className="diff-line add">
                  <span className="diff-sign">+</span>
                  {l || " "}
                  {"\n"}
                </span>
              ))}
            </pre>
            {lines.length > shown.length && <p className="muted small">{lines.length - shown.length} more lines not shown.</p>}
          </Section>
        );
      }
    }
  }
  const text = prettyJson(input);
  return (
    <Section label="Input" copy={text}>
      <pre className="code">{text || "(none)"}</pre>
    </Section>
  );
}
