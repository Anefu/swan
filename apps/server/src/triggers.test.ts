import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "./settings.js";
import { TrackerStore } from "./tracker.js";
import { lookup, render, TriggerManager, type TriggerTarget } from "./triggers.js";
import type { PersonaStore } from "./personas.js";
import { PersonaSchema } from "./personas.js";

describe("watcher templates", () => {
  it("looks up paths and converts page URLs to API URLs", () => {
    const ctx = { item: { fields: { summary: "Fix it" }, n: 3 }, tracker: { url: "https://gitlab.example.com/platform/api/-/merge_requests/482" } };
    expect(lookup(ctx, "item.fields.summary")).toBe("Fix it");
    expect(render("{{item.fields.summary}} #{{ item.n }} {{nope.x}}", ctx)).toBe("Fix it #3 ");
    expect(render("{{gitlabApi tracker.url}}/notes", ctx)).toBe("https://gitlab.example.com/api/v4/projects/platform%2Fapi/merge_requests/482/notes");
    expect(render("{{githubApi u}}", { u: "https://github.com/o/r/pull/5" })).toBe("https://api.github.com/repos/o/r/issues/5");
  });
});

describe("watchers", () => {
  const setup = async (responses: (() => { code: number; stdout: string; stderr: string })[]) => {
    for (const d of ["triggers", "tracker"]) await fs.rm(path.join(paths.home, d), { recursive: true, force: true });
    const cfg = PersonaSchema.parse({
      name: "W",
      watchers: [
        { name: "notes", every: "1m", forEach: { tracker: { kind: "mr" } }, get: "{{tracker.url}}/notes", items: "", id: "id", skip: { system: true }, prompt: "{{item.author}}: {{item.body}}" },
      ],
      unattended: { maxTurnsPerDay: 1 },
    });
    const personas = { get: () => ({ id: "w", config: cfg }), list: () => [{ id: "w", config: cfg }] } as unknown as PersonaStore;
    const tracker = new TrackerStore();
    await tracker.track("w", { url: "https://gitlab.example.com/g/p/-/merge_requests/1", title: "MR", kind: "mr" }, "agent");
    const fired: { label: string; prompt: string }[] = [];
    const argvs: string[][] = [];
    const target: TriggerTarget = {
      trigger: (label, prompt) => fired.push({ label, prompt }),
      pollExec: async (argv) => {
        argvs.push(argv);
        return responses.shift()!();
      },
    };
    const m = new TriggerManager({ personas, tracker, target: () => target });
    return { m, fired, argvs };
  };
  const ok = (items: unknown[]) => () => ({ code: 0, stdout: JSON.stringify(items), stderr: "" });

  it("records on the first check, then starts one turn for what's new, within the daily limit", async () => {
    const { m, fired, argvs } = await setup([
      ok([{ id: 1, author: "sam", body: "old" }]),
      ok([{ id: 1, author: "sam", body: "old" }, { id: 2, author: "lee", body: "LGTM" }, { id: 3, system: true, body: "bot" }]),
      ok([{ id: 4, author: "kim", body: "one more" }]),
    ]);
    await m.runNow("w", "notes");
    expect(fired).toEqual([]);
    expect(argvs[0]!.at(-1)).toBe("https://gitlab.example.com/g/p/-/merge_requests/1/notes");
    await m.runNow("w", "notes");
    expect(fired).toEqual([{ label: "watcher notes · 1 new", prompt: "lee: LGTM" }]);
    await m.runNow("w", "notes");
    expect(fired).toHaveLength(1); // the daily limit is 1
    expect((await m.info("w")).triggers[0]!.lastError).toMatch(/triggered turns for today/);
  });

  it("backs off after a failure and says why", async () => {
    const { m } = await setup([() => ({ code: 22, stdout: "", stderr: "curl: (22) The requested URL returned error: 401" })]);
    await m.runNow("w", "notes");
    const t = (await m.info("w")).triggers[0]!;
    expect(t.failures).toBe(1);
    expect(t.lastError).toMatch(/401/);
    expect(new Date(t.nextRun!).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("tests a watcher without recording or starting anything", async () => {
    const { m, fired } = await setup([ok([{ id: 7, author: "sam", body: "hi" }])]);
    const r = await m.test("w", "notes");
    expect(r).toMatchObject({ checked: 1, items: 1, matching: [{ label: "7", text: "sam: hi" }] });
    expect(fired).toEqual([]);
    expect((await m.info("w")).triggers[0]!.lastRun).toBeNull();
  });
});

describe("reminders", () => {
  it("run once when due, late if need be, and never again", async () => {
    for (const d of ["triggers", "tracker"]) await fs.rm(path.join(paths.home, d), { recursive: true, force: true });
    const cfg = PersonaSchema.parse({ name: "R", schedules: [{ name: "call", once: "2026-01-05 17:00", prompt: "Remind the user to call Sam." }] });
    const personas = { get: () => ({ id: "r", config: cfg }), list: () => [{ id: "r", config: cfg }] } as unknown as PersonaStore;
    const fired: string[] = [];
    const target: TriggerTarget = { trigger: (_l, p) => fired.push(p), pollExec: async () => ({ code: 0, stdout: "", stderr: "" }) };
    const m = new TriggerManager({ personas, tracker: new TrackerStore(), target: () => target });
    const tick = () => (m as unknown as { tick(): Promise<void> }).tick();
    await tick();
    await tick();
    expect(fired).toEqual(["Remind the user to call Sam."]);
    expect((await m.info("r")).triggers[0]).toMatchObject({ nextRun: null });
    expect(() => PersonaSchema.parse({ name: "R", schedules: [{ name: "x", once: "5pm", prompt: "p" }] })).toThrow(/local date and time/);
  });
});
