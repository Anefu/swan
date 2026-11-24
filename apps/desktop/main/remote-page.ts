import { DEFAULT_REMOTE, type RemoteServer, type ServerChoice, parseRemote } from "./remote.js";

/** Where the form submits: never loaded, the window catches the navigation. */
export const CONNECT_URL = "swan://connect/";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * "Connect to Remote Swan": a plain form with no script. Submitting it navigates to CONNECT_URL
 * with the fields in the query, which the main process reads and cancels.
 */
export function connectPage(choice: ServerChoice, error = "", values?: { host?: string; port?: string; home?: string }): string {
  const r = choice.remote;
  const v = {
    host: values?.host ?? r?.host ?? "",
    port: values?.port ?? String(r?.port ?? DEFAULT_REMOTE.port),
    home: values?.home ?? r?.home ?? DEFAULT_REMOTE.home,
  };
  const field = (name: string, label: string, value: string, hint: string, extra = "") =>
    `<label for="${name}">${label}</label><input id="${name}" name="${name}" value="${esc(value)}" aria-describedby="${name}-hint" autocomplete="off" spellcheck="false" ${extra}><p class="hint" id="${name}-hint">${hint}</p>`;
  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action swan:">
<title>Connect to Remote Swan</title>
<style>
html{color-scheme:dark}
body{margin:0;padding:20px 24px;background:#1a1f28;color:#eef1f6;font:13px system-ui,-apple-system,sans-serif}
p{margin:0 0 14px;color:#aeb9ca;line-height:1.45}
label{display:block;margin-bottom:4px}
input{box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid #3b4657;border-radius:6px;background:#181d25;color:inherit;font:12px ui-monospace,Menlo,monospace}
.hint{margin:3px 0 12px;font-size:12px}
.error{color:#ff9c8a}
.row{display:flex;flex-direction:row-reverse;gap:8px;margin-top:6px}
button{padding:5px 12px;border:1px solid #3b4657;border-radius:6px;background:#2a3340;color:inherit;font:inherit}
button.primary{background:#b2a1e8;border-color:#b2a1e8;color:#17131f}
button:last-child{margin-right:auto}
:focus-visible{outline:2px solid #d6ccf7;outline-offset:1px}
code{font:12px ui-monospace,Menlo,monospace}
</style>
<form action="${CONNECT_URL}" method="get">
<p>Use a Swan server on another machine. It must already be running there (<code>swan-server</code>), and <code>ssh</code> to it must work without a password prompt.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
${field("host", "SSH host", v.host, "A name from ~/.ssh/config, such as coder.myworkspace after <code>coder config-ssh</code>.", 'autofocus required placeholder="coder.myworkspace"')}
${field("port", "Port", v.port, "The port: setting in Swan's config.yaml there.", 'inputmode="numeric"')}
${field("home", "Swan's home", v.home, "PH_HOME there; Swan reads its API token from this folder.")}
<!-- Connect first, so Enter in a field connects; the row shows them right to left. -->
<div class="row">
<button name="use" value="remote" type="submit" class="primary">Connect</button>
<button name="use" value="cancel" type="submit" formnovalidate>Cancel</button>
<button name="use" value="local" type="submit" formnovalidate>Use This Mac</button>
</div>
</form>`;
}

export type ConnectAnswer =
  | { use: "remote"; remote: RemoteServer }
  | { use: "local" }
  | { use: "cancel" }
  | { use: "invalid"; error: string; values: { host: string; port: string; home: string } };

/** What a submitted form asked for; null for a URL that isn't the form's. */
export function readConnectUrl(url: string): ConnectAnswer | null {
  if (!url.startsWith(CONNECT_URL)) return null;
  const q = new URL(url).searchParams;
  const use = q.get("use");
  if (use === "local") return { use: "local" };
  if (use !== "remote") return { use: "cancel" };
  const values = { host: q.get("host") ?? "", port: q.get("port") ?? "", home: q.get("home") ?? "" };
  const parsed = parseRemote(values);
  return "error" in parsed ? { use: "invalid", error: parsed.error, values } : { use: "remote", remote: parsed.remote };
}
