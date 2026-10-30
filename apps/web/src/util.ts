import { useEffect, useState } from "react";
import type { RuntimeStatus, SessionStatus, ToolCallStatus } from "@ph/shared";

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unexpected error";
}

export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fullTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

export function clockTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtTokens(n: number | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** mcp__github__create_issue -> { server: "github", tool: "create_issue" } */
export function toolDisplayName(name: string): { server?: string; tool: string } {
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const i = rest.indexOf("__");
    if (i > 0) return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
  }
  return { tool: name };
}

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  starting: "Starting",
  idle: "Idle",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  error: "Error",
  stopped: "Stopped",
};

export const TOOL_STATUS_LABEL: Record<ToolCallStatus, string> = {
  pending_approval: "Needs approval",
  running: "Running",
  done: "Done",
  error: "Error",
  denied: "Denied",
  interrupted: "Interrupted",
};

export function isBusy(status: SessionStatus | undefined): boolean {
  return status === "running" || status === "awaiting_approval";
}

export type RuntimeLevel = "ok" | "busy" | "error" | "unknown";

export function runtimeLevel(r: RuntimeStatus | null): RuntimeLevel {
  if (!r) return "unknown";
  if (r.busy) return "busy";
  if (r.available && r.imageReady && r.networkReady && r.relayRunning && r.errors.length === 0) return "ok";
  return "error";
}

export function runtimeProblems(r: RuntimeStatus): string[] {
  const out: string[] = [];
  if (!r.available) out.push(`${r.runtime || "container runtime"} not available`);
  else {
    if (!r.imageReady) out.push("sandbox image missing");
    if (!r.networkReady) out.push("sandbox network not ready");
    if (!r.relayRunning) out.push("egress relay not running");
  }
  return out;
}

/** Split a comma/newline/space separated host list. */
export function parseList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Line numbers mentioned in error strings ("... at line 4, column 2"). */
export function errorLines(errors: Array<string | null | undefined>): Set<number> {
  const out = new Set<number>();
  for (const e of errors) {
    if (!e) continue;
    for (const m of e.matchAll(/\bline (\d+)/gi)) out.add(Number(m[1]));
  }
  return out;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function prettyJson(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

/** Re-render periodically so relative times stay fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
