import path from "node:path";
import { paths } from "../settings.js";

/**
 * Where things are as commands see them. In a Podman sandbox: /home/agent, /workspace/<folder>
 * and /skills/<name>. With `runtime.type: workspace` commands run on this machine, so folders and
 * skills are at their real paths and each conversation gets a home of its own under PH_HOME.
 */
let workspace = false;

export function useWorkspaceLayout(on: boolean) {
  workspace = on;
}

export const inWorkspace = () => workspace;

/** The agent's home: connection files, swan-tool and attachments go here. */
export function agentHome(sessionId: string): string {
  return workspace ? path.join(paths.home, "agents", sessionId) : "/home/agent";
}

export const envFile = (sessionId: string) => `${agentHome(sessionId)}/.swan/env.sh`;
export const swanToolPath = (sessionId: string) => `${agentHome(sessionId)}/.swan/bin/swan-tool`;
export const attachmentsDir = (sessionId: string) => `${agentHome(sessionId)}/attachments`;

/** Where a skill's files are for commands. */
export const skillPath = (name: string, hostPath: string) => (workspace ? hostPath : `/skills/${name}`);

/** Where a persona folder appears to commands when the persona doesn't say. */
export const defaultMount = (realPath: string) => (workspace ? realPath : `/workspace/${path.basename(realPath)}`);

/** The working directory when a persona has no folders. */
export const fallbackWorkdir = (sessionId: string) => (workspace ? agentHome(sessionId) : "/workspace");
