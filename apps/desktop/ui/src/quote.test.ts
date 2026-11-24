import { describe, expect, it } from "vitest";
import { composeMessage, diffQuote, splitQuotes, toQuote } from "./quote";

describe("toQuote", () => {
  it("quotes each line and keeps one blank between paragraphs", () => {
    expect(toQuote("  first line\nsecond  \n\n\n\nthird\n")).toBe("> first line\n> second\n>\n> third");
  });
  it("is empty for whitespace", () => {
    expect(toQuote(" \n\t ")).toBe("");
  });
});

describe("composeMessage", () => {
  const q = (text: string, reply = "") => ({ id: text, text, reply });
  it("puts each reply under its quote, then the main text", () => {
    expect(composeMessage([q("first", " why? "), q("second\nline", "and this")], "thanks")).toBe(
      "> first\n\nwhy?\n\n> second\n> line\n\nand this\n\nthanks",
    );
  });
  it("sends a quote without a reply as just the quote", () => {
    expect(composeMessage([q("first"), q("second", "ok")], "")).toBe("> first\n\n> second\n\nok");
  });
  it("skips quotes with no text", () => {
    expect(composeMessage([q("  ")], "hi")).toBe("hi");
  });
  it("round-trips through splitQuotes", () => {
    expect(splitQuotes(composeMessage([q("a", "r1"), q("b", "r2")], "end"))).toEqual([
      { quote: true, text: "a" },
      { quote: false, text: "r1" },
      { quote: true, text: "b" },
      { quote: false, text: "r2\n\nend" },
    ]);
  });
});

describe("splitQuotes", () => {
  it("separates quotes from the replies to them", () => {
    expect(splitQuotes("> first\n>\n> more\n\nwhy?\n\n> second\n\nand this")).toEqual([
      { quote: true, text: "first\n\nmore" },
      { quote: false, text: "why?" },
      { quote: true, text: "second" },
      { quote: false, text: "and this" },
    ]);
  });
  it("leaves a message without quotes as one part", () => {
    expect(splitQuotes("a > b\nc")).toEqual([{ quote: false, text: "a > b\nc" }]);
  });
  it("does not treat >= or >> as a quote", () => {
    expect(splitQuotes(">= 3")).toEqual([{ quote: false, text: ">= 3" }]);
  });
});

describe("diff comments", () => {
  const on = (label: string) => ({ diffId: "d", path: "src/a.ts", hunk: 0, from: 0, to: 0, label });
  it("names the file and the new line numbers, and marks added and removed lines", () => {
    const r = diffQuote("src/a.ts", [
      { kind: "del", old: 4, text: "  old()" },
      { kind: "add", new: 4, text: "  next()" },
      { kind: "ctx", old: 5, new: 5, text: "}" },
    ]);
    expect(r.label).toBe("src/a.ts lines 4–5");
    expect(r.text).toBe("-   old()\n+   next()\n  }");
  });
  it("uses the old numbers for lines that were only removed", () => {
    expect(diffQuote("a", [{ kind: "del", old: 9, text: "x" }]).label).toBe("a line 9 (removed)");
  });
  it("sends the lines with their indentation, then the comment", () => {
    const c = { id: "1", text: "+   next()", reply: " rename this ", on: on("src/a.ts line 4") };
    expect(composeMessage([c], "thanks")).toBe("On src/a.ts line 4:\n> +   next()\n\nrename this\n\nthanks");
  });
  it("leaves out a comment with nothing written", () => {
    expect(composeMessage([{ id: "1", text: "+ x", reply: "  ", on: on("a line 1") }], "hi")).toBe("hi");
  });
});
