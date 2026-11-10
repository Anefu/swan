import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FileStore } from "./file-store.js";

const Schema = z.object({ n: z.number(), notes: z.array(z.string()).default([]) });
let dir: string;
const store = (format: "json" | "yaml" = "json") => new FileStore({ name: "test", dir: () => dir, format, schema: Schema, empty: () => ({ n: 0, notes: [] }), mode: 0o600 });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-store-"));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe("FileStore", () => {
  it("starts a key that has no file empty, and writes it on save", async () => {
    const s = store("yaml");
    (await s.get("a")).n = 2;
    await s.save("a");
    expect(await fs.readFile(path.join(dir, "a.yaml"), "utf8")).toContain("n: 2");
    expect(await store("yaml").get("a")).toEqual({ n: 2, notes: [] });
  });

  it("moves a file that is not valid aside instead of writing over it", async () => {
    await fs.writeFile(path.join(dir, "a.json"), JSON.stringify({ n: "two" }));
    const s = store();
    expect(await s.get("a")).toEqual({ n: 0, notes: [] });
    await s.save("a");
    const files = await fs.readdir(dir);
    const aside = files.find((f) => f.startsWith("a.json.invalid-"))!;
    expect(JSON.parse(await fs.readFile(path.join(dir, aside), "utf8"))).toEqual({ n: "two" });
  });

  it("shares the first read between callers, so no change goes to a copy that is then dropped", async () => {
    const s = store();
    const [a, b] = await Promise.all([s.get("k"), s.get("k")]);
    expect(a).toBe(b);
  });

  it("runs changes to a key one at a time, each on the latest value", async () => {
    const s = store();
    await Promise.all(
      ["x", "y", "z"].map((note) =>
        s.change("k", async (v) => {
          const seen = v.notes.length;
          await new Promise((r) => setTimeout(r, 5));
          v.notes.push(`${note}${seen}`);
        }),
      ),
    );
    expect((await store().get("k")).notes).toEqual(["x0", "y1", "z2"]);
  });

  it("copies a key's file, and only when there is one", async () => {
    const s = store();
    await s.change("a", (v) => void (v.n = 5));
    await s.copy("a", "b");
    await s.copy("missing", "c");
    expect(await store().get("b")).toEqual({ n: 5, notes: [] });
    expect(await fs.readdir(dir)).not.toContain("c.json");
    await s.remove("a");
    expect(await fs.readdir(dir)).not.toContain("a.json");
    expect(await s.get("a")).toEqual({ n: 0, notes: [] });
  });
});
