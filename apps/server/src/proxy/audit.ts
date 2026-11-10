// Every request the proxy handled: kept in memory for the UI, appended to a log file per UTC day,
// and reloaded from those files on start.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EgressEvent } from "@ph/shared";
import { paths } from "../settings.js";
import { nowIso, randomId } from "../util.js";

/** Requests reloaded from the audit log on start, newest last; the UI asks for at most this many. */
const RESTORED_EVENTS = 2000;
const KEPT_EVENTS = 5000;

export type AuditEntry = Omit<EgressEvent, "id" | "ts">;

export class EgressAudit {
  private recent: EgressEvent[] = [];

  constructor(private onEvent: (e: EgressEvent) => void) {}

  async restore() {
    this.recent = await restoreEvents();
  }

  events(sessionId?: string, limit = 200): EgressEvent[] {
    const list = sessionId ? this.recent.filter((e) => e.sessionId === sessionId) : this.recent;
    return list.slice(-limit);
  }

  record(e: AuditEntry) {
    const ev: EgressEvent = { id: randomId("eg_", 6), ts: nowIso(), ...e };
    if (!ev.denied?.length) delete ev.denied;
    this.recent.push(ev);
    if (this.recent.length > KEPT_EVENTS) this.recent.splice(0, this.recent.length - KEPT_EVENTS);
    this.onEvent(ev);
    const file = path.join(paths.audit, `egress-${ev.ts.slice(0, 10)}.jsonl`);
    fs.appendFile(file, JSON.stringify(ev) + "\n", { mode: 0o600 }).catch(() => {});
  }
}

/**
 * Recent history from the audit logs (one file per UTC day), newest files first until there is enough,
 * so the UI keeps earlier requests across restarts and past midnight. Unreadable files and lines are skipped.
 */
async function restoreEvents(): Promise<EgressEvent[]> {
  let files: string[];
  try {
    files = (await fs.readdir(paths.audit)).filter((f) => /^egress-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  let events: EgressEvent[] = [];
  for (const f of files.sort().reverse()) {
    let text: string;
    try {
      text = await fs.readFile(path.join(paths.audit, f), "utf8");
    } catch {
      continue;
    }
    const day = text.split("\n").flatMap((l) => {
      if (!l.trim()) return [];
      try {
        return [JSON.parse(l) as EgressEvent];
      } catch {
        return [];
      }
    });
    events = day.concat(events);
    if (events.length >= RESTORED_EVENTS) break;
  }
  return events.slice(-RESTORED_EVENTS);
}
