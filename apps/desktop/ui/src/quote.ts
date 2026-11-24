/** Selected conversation text as a markdown quote: "> " on each line, runs of blank lines kept as one quoted blank. */
export function toQuote(selected: string): string {
  const clean = selected.replace(/\r\n?/g, "\n").replace(/ /g, " ").trim();
  if (!clean) return "";
  const lines = clean.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line && out[out.length - 1] === ">") continue;
    out.push(line ? `> ${line}` : ">");
  }
  return out.join("\n");
}

/** Where a comment on a diff in the Changes pane sits: lines `from`–`to` of one hunk of one file. */
export type DiffSpot = { diffId: string; path: string; hunk: number; from: number; to: number; label: string };

/** A quote waiting in the draft: a passage of the conversation, or lines of a diff (`on`). */
export type DraftQuote = { id: string; text: string; reply: string; on?: DiffSpot };

type DiffLine = { kind: "add" | "del" | "ctx"; old?: number; new?: number; text: string };

const MAX_QUOTED_LINES = 40;

/** A comment on these diff lines: where they are, as the agent reads it, and the lines marked + or -. */
export function diffQuote(path: string, lines: DiffLine[]): { label: string; text: string } {
  const span = (ns: number[]) => (ns[0] === ns[ns.length - 1] ? `line ${ns[0]}` : `lines ${ns[0]}–${ns[ns.length - 1]}`);
  const now = lines.flatMap((l) => (l.new === undefined ? [] : [l.new]));
  const before = lines.flatMap((l) => (l.old === undefined ? [] : [l.old]));
  const label = now.length ? `${path} ${span(now)}` : `${path} ${span(before)} (removed)`;
  const shown = lines.slice(0, MAX_QUOTED_LINES).map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`);
  if (lines.length > MAX_QUOTED_LINES) shown.push(`… ${lines.length - MAX_QUOTED_LINES} more lines`);
  return { label, text: shown.join("\n") };
}

/** The message the agent gets: each quote followed by its reply, then the main text. */
export function composeMessage(quotes: DraftQuote[], text: string): string {
  const parts: string[] = [];
  for (const q of quotes) {
    if (q.on) {
      // Code keeps its indentation; a comment with nothing written says nothing, so it isn't sent.
      if (!q.reply.trim()) continue;
      parts.push(`On ${q.on.label}:\n${q.text.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n")}`);
      parts.push(q.reply.trim());
      continue;
    }
    const quote = toQuote(q.text);
    if (!quote) continue;
    parts.push(quote);
    if (q.reply.trim()) parts.push(q.reply.trim());
  }
  if (text.trim()) parts.push(text.trim());
  return parts.join("\n\n");
}

export type MessagePart = { quote: boolean; text: string };

/** A sent message split into quoted runs (lines starting with ">") and the text around them. */
export function splitQuotes(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const line of text.split("\n")) {
    const quote = /^>( |$)/.test(line);
    const body = quote ? line.replace(/^> ?/, "") : line;
    const last = parts[parts.length - 1];
    if (last && last.quote === quote) last.text += `\n${body}`;
    else parts.push({ quote, text: body });
  }
  // Blank lines that only separate a quote from the reply are spacing, not content.
  return parts.map((p) => (p.quote ? p : { quote: false, text: p.text.replace(/^\n+|\n+$/g, "") })).filter((p) => p.quote || p.text);
}
