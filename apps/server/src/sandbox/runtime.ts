import type { RuntimeStatus } from "@ph/shared";
import type { Settings } from "../settings.js";
import type { RunResult, SessionContainerSpec } from "./podman.js";

export type ExecOpts = {
  input?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutput?: number;
  onStdout?: (chunk: string) => void;
};

export type ShellOpts = { cwd?: string; timeoutMs: number; signal?: AbortSignal; maxOutput?: number; env?: Record<string, string> };

/** Where conversations' commands run: a Podman container each, or this machine (a cloud workspace). */
export interface SandboxRuntime {
  status: RuntimeStatus;
  on(event: "status", fn: (s: RuntimeStatus) => void): () => void;
  init(): Promise<void>;
  setupMachine(): Promise<void>;
  rebuild(): Promise<void>;
  sessionImage(sandbox: { image?: string; tools?: Settings["sandboxTools"] }): Promise<string>;
  proxyUrl(sessionId: string, token: string): string;
  startSession(spec: SessionContainerSpec): Promise<string>;
  stopSession(sessionId: string): Promise<void>;
  removeOrphans(keep?: Set<string>): Promise<void>;
  exec(container: string, argv: string[], opts?: ExecOpts): Promise<RunResult>;
  execShell(container: string, command: string, opts: ShellOpts): Promise<RunResult & { timedOut: boolean }>;
  /** The command and arguments that run argv with stdio attached (stdio MCP servers). */
  stdioCommand(container: string, argv: string[], opts: { env?: Record<string, string>; cwd?: string }): { command: string; args: string[]; env?: Record<string, string>; cwd?: string };
}
