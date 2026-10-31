import { spawn } from "node:child_process";

const MARK = "__SWAN_ENV_7f3a__";

/** Where Homebrew, the Podman installer and Podman Desktop put `podman`. */
export const PODMAN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/podman/bin"];

/** The NUL-separated `env -0` output a shell printed between two markers (rc files may print around it). */
export function parseEnvOutput(out: string): Record<string, string> | null {
  const start = out.indexOf(MARK);
  const end = out.lastIndexOf(MARK);
  if (start < 0 || end <= start) return null;
  const env: Record<string, string> = {};
  for (const entry of out.slice(start + MARK.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return Object.keys(env).length ? env : null;
}

/** PATH with Podman's usual directories appended when missing. */
export function withPodmanDirs(pathVar: string | undefined): string {
  const parts = (pathVar ?? "").split(":").filter(Boolean);
  for (const d of PODMAN_DIRS) if (!parts.includes(d)) parts.push(d);
  return parts.join(":");
}

/**
 * The environment a new terminal would have. Apps started from the Finder get launchd's minimal
 * one, without the PATH that finds podman, connection wrappers and their CLIs. Null when the shell
 * fails or takes too long; the caller falls back to its own environment.
 */
export function loginShellEnv(shell = process.env.SHELL || "/bin/zsh", timeoutMs = 5000): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const child = spawn(shell, ["-ilc", `printf '%s' ${MARK}; /usr/bin/env -0; printf '%s' ${MARK}`], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, SWAN_RESOLVING_ENVIRONMENT: "1" }, // lets rc files skip slow setup
      detached: true, // own process group, so a timeout also stops anything the rc files started
    });
    let out = "";
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      resolve(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseEnvOutput(out));
    });
  });
}

/**
 * The server's environment: the user's shell environment (as `pnpm start` from a terminal would
 * have), without variables that would change how Node or Electron behave or which home is used.
 */
export function serverEnv(base: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("ELECTRON_") || k === "NODE_OPTIONS" || k === "PH_HOME" || k === "SWAN_RESOLVING_ENVIRONMENT") continue;
    env[k] = v;
  }
  env.PATH = withPodmanDirs(env.PATH);
  return { ...env, ...extra };
}
