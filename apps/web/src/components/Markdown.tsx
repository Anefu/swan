import { memo, useEffect, useMemo, useRef, type MouseEvent } from "react";
import { renderMarkdown } from "../markdown";
import { copyText } from "../util";

const COPY_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);

  // Decorate code blocks with a copy button (the HTML is ours to touch until it changes).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(":scope > .md-copy")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "md-copy";
      btn.title = "Copy code";
      btn.setAttribute("aria-label", "Copy code");
      btn.innerHTML = COPY_SVG;
      pre.appendChild(btn);
    });
  }, [html]);

  const onClick = async (e: MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest(".md-copy");
    if (!btn) return;
    const pre = btn.parentElement;
    const code = pre?.querySelector("code")?.textContent ?? "";
    if (await copyText(code)) {
      btn.classList.add("done");
      window.setTimeout(() => btn.classList.remove("done"), 1200);
    }
  };

  return (
    <div className="md-wrap">
      <div ref={ref} className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {streaming && <span className="caret" aria-hidden="true" />}
    </div>
  );
});
