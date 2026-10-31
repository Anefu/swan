import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCampaign } from "./schema.js";

const campaigns = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../campaigns");

describe("campaign and case files", () => {
  it("every campaign in the repository loads, with its cases and their workspaces", async () => {
    const files = (await fs.readdir(campaigns)).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const { campaign, cases } = await loadCampaign(path.join(campaigns, f));
      expect(cases.length, f).toBe(campaign.cases.length);
      for (const k of cases) if (k.workspace) await expect(fs.stat(k.workspace)).resolves.toBeTruthy();
    }
  });
});
