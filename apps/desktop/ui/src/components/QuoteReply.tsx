import { useEffect, useState, type RefObject } from "react";
import { IconReply } from "./icons";

/**
 * A small Reply button over text selected in the conversation. Each press adds the selection to the
 * draft as a quote, so several passages can be quoted, each followed by its own reply.
 */
export function QuoteReply({ scrollRef, onQuote }: { scrollRef: RefObject<HTMLDivElement | null>; onQuote: (text: string) => void }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const place = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setAt(null);
      const range = sel.getRangeAt(0);
      const items = el.querySelector(".items");
      const text = sel.toString();
      if (!items || !items.contains(range.commonAncestorContainer) || !text.trim()) return setAt(null);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
      const view = el.getBoundingClientRect();
      const first = rects[0] ?? range.getBoundingClientRect();
      const last = rects[rects.length - 1] ?? first;
      // Above the first selected line; below the last one when the first has scrolled off the top.
      let y = first.top - 34;
      if (y < view.top + 4) y = last.bottom + 6;
      if (y > view.bottom - 30 || last.bottom < view.top) return setAt(null);
      const x = Math.min(Math.max(first.left + 30, view.left + 40), view.right - 40);
      setAt({ x, y, text });
    };
    // Shown once a drag or a Shift+arrow selection ends, not while it is still growing.
    const onUp = () => window.setTimeout(place, 0);
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setAt(null);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("selectionchange", onChange);
    el.addEventListener("scroll", place, { passive: true });
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("selectionchange", onChange);
      el.removeEventListener("scroll", place);
    };
  }, [scrollRef]);

  if (!at) return null;
  return (
    <button
      type="button"
      className="quote-btn"
      style={{ left: at.x, top: at.y }}
      aria-label="Quote the selected text in your reply"
      // Keep the selection while the button is pressed.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(at.text);
        window.getSelection()?.removeAllRanges();
        setAt(null);
      }}
    >
      <IconReply size={13} />
      Reply
    </button>
  );
}
