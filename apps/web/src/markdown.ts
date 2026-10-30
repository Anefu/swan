import DOMPurify from "dompurify";
import { marked } from "marked";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Markdown -> sanitized HTML. Model output is untrusted, so everything goes through DOMPurify. */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false, gfm: true, breaks: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "iframe"],
    FORBID_ATTR: ["style"],
  });
}
