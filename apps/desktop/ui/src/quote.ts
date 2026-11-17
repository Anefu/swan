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

export type DraftQuote = { id: string; text: string; reply: string };

/** The message the agent gets: each quote followed by its reply, then the main text. */
export function composeMessage(quotes: DraftQuote[], text: string): string {
  const parts: string[] = [];
  for (const q of quotes) {
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
