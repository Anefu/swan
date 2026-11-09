import DOMPurify from "dompurify";
import { Marked } from "marked";

const SAFE_HREF = /^(https?:|mailto:)/i;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A") return;
  // Only web and mail links: a relative or swan:// link would open another app window.
  const href = node.getAttribute("href");
  if (href && !SAFE_HREF.test(href.trim())) node.removeAttribute("href");
  if (node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// A Markdown image becomes a link: loading it would fetch the URL from this Mac, outside the proxy.
const marked = new Marked({
  async: false,
  gfm: true,
  breaks: false,
  renderer: {
    image({ href, text }) {
      const label = text || href;
      return `<a href="${encodeURI(href)}">${label.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)}</a>`;
    },
  },
});

/** Markdown -> sanitized HTML. Model output is untrusted, so everything goes through DOMPurify. */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // No images or form controls, and no class, id or name: a reply can't load anything, pose as
    // Swan's own buttons and cards, or take an id the app looks up.
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "input", "iframe", "img", "picture", "source", "video", "audio", "svg", "math"],
    FORBID_ATTR: ["style", "class", "id", "name", "srcset"],
  });
}
