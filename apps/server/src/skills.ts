import { promises as fs } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import YAML from "yaml";
import type { SkillSummary } from "@ph/shared";
import { paths, type Settings } from "./settings.js";
import { TypedEmitter, debounce, errMsg, exists, expandHome, log } from "./util.js";

export interface Skill extends SkillSummary {
  body: string; // SKILL.md without frontmatter
}

/** Parse SKILL.md (Agent Skills format: YAML frontmatter with name + description, markdown body). */
function parseSkillMd(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  return { meta: (YAML.parse(m[1]) as Record<string, unknown>) ?? {}, body: m[2] };
}

export class SkillRegistry extends TypedEmitter<{ changed: [] }> {
  private skills = new Map<string, Skill>();
  constructor(private settings: Settings) {
    super();
  }

  get roots(): string[] {
    return [paths.skills, ...this.settings.skillDirs.map((d) => path.resolve(expandHome(d)))];
  }

  async load(): Promise<void> {
    const next = new Map<string, Skill>();
    for (const root of this.roots) {
      if (!(await exists(root))) continue;
      for (const dir of await fs.readdir(root, { withFileTypes: true })) {
        if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
        const skillDir = path.join(root, dir.name);
        const md = path.join(skillDir, "SKILL.md");
        if (!(await exists(md))) continue;
        try {
          const { meta, body } = parseSkillMd(await fs.readFile(md, "utf8"));
          const name = typeof meta.name === "string" ? meta.name : dir.name;
          if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
            log.warn("skills", `skipping ${skillDir}: invalid skill name "${name}"`);
            continue;
          }
          if (next.has(name)) continue; // earlier roots win
          next.set(name, {
            name,
            description: typeof meta.description === "string" ? meta.description : "",
            hostPath: await fs.realpath(skillDir),
            source: root,
            body,
          });
        } catch (e) {
          log.warn("skills", `failed to load ${md}: ${errMsg(e)}`);
        }
      }
    }
    this.skills = next;
    this.emit("changed");
  }

  watch(): void {
    const reload = debounce(() => this.load().catch((e) => log.error("skills", errMsg(e))), 200);
    chokidar.watch(this.roots, { ignoreInitial: true, depth: 2 }).on("all", reload);
  }

  get(name: string) {
    return this.skills.get(name);
  }

  list(): SkillSummary[] {
    return [...this.skills.values()].map(({ body: _b, ...s }) => s).sort((a, b) => a.name.localeCompare(b.name));
  }
}
