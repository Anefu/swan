import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebPreferences, app, dialog, protocol, session, shell } from "electron";
import type { LauncherMessage } from "@ph/shared";
import { appCsp, resolveUiFile, uiContentType } from "./app-protocol.js";
import { ServerProcess } from "./server.js";
import { loginShellEnv, serverEnv } from "./shell-env.js";
import { loadWindowState, trackWindowState } from "./window-state.js";

const BACKGROUND = "#1a1f28"; // --canvas in the UI's styles.css
const REPO_URL = "https://github.com/Anefu/swan";
const APP_URL = "swan://app/";
// CI launches the packaged app with this set: start, check the UI and API, quit.
const SMOKE = process.env.SWAN_SMOKE_TEST === "1";
// Development: the UI comes from Vite (hot reload) and `pnpm dev` runs the server.
const DEV_URL = app.isPackaged ? undefined : process.env.SWAN_DEV_URL;

const SAFE_PREFS: WebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
  spellcheck: true,
};

app.setName("Swan");
protocol.registerSchemesAsPrivileged([{ scheme: "swan", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);

// PH_HOME in the launch environment (not the shell's) selects a test instance, with its own
// browser profile and single-instance lock so it can run beside the everyday app.
const homeOverride = process.env.PH_HOME ? path.resolve(process.env.PH_HOME.replace(/^~(?=$|\/)/, os.homedir())) : null;
const instance = homeOverride ? createHash("sha256").update(homeOverride).digest("hex").slice(0, 12) : null;
if (instance) app.setPath("userData", path.join(app.getPath("appData"), "Swan", "instances", instance));

const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "build", "resources");
const uiDir = path.join(resources, "ui");
const nodeBinary = app.isPackaged ? path.join(resources, "node") : (process.env.SWAN_NODE ?? "node");
const logFile = path.join(app.getPath("logs"), instance ? `server-${instance}.log` : "server.log");

let win: BrowserWindow | null = null;
let server: ServerProcess | null = null; // only a server this app started; an attached one is left alone
let api: { origin: string; port: string; token: string } | null = null; // the server the UI talks to
let home = homeOverride ?? path.join(os.homedir(), ".swan");
let shellEnv: Record<string, string> | null | undefined;
let quitting = false;
const crashes: number[] = [];

const tildify = (p: string) => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

/** Swan's own pages: swan://app, or the Vite page in development. */
function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (DEV_URL) return u.origin === new URL(DEV_URL).origin;
    return u.protocol === "swan:" && u.host === "app";
  } catch {
    return false;
  }
}

function openOutside(url: string) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** swan://app: the UI from the app bundle, and /api/ passed through to the server. */
async function handleApp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.host !== "app") return new Response(null, { status: 404 });
  if (url.pathname.startsWith("/api/")) return passToServer(req, url);
  const file = await resolveUiFile(uiDir, url.pathname);
  if (file) return new Response(await fs.readFile(file), { headers: { "content-type": uiContentType(file), "x-content-type-options": "nosniff" } });
  // Any other path is the single-page app; the page gets the token and the WebSocket address.
  if (!api) return new Response(null, { status: 503 });
  const html = (await fs.readFile(path.join(uiDir, "index.html"), "utf8"))
    .replace("__PH_TOKEN__", escapeAttr(api.token))
    .replace("__PH_WS__", escapeAttr(`ws://127.0.0.1:${api.port}/api/ws`));
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": appCsp(api.port) } });
}

async function passToServer(req: Request, url: URL): Promise<Response> {
  if (!api) return new Response(null, { status: 503 });
  const headers = new Headers(req.headers);
  headers.delete("host");
  try {
    return await fetch(`${api.origin}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
      duplex: "half",
    } as RequestInit);
  } catch {
    return new Response(null, { status: 502 }); // an empty 5xx is how the UI recognises "server unreachable"
  }
}

function hardenSession() {
  const ses = session.defaultSession;
  // Copy buttons need clipboard writes; nothing else is granted.
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(permission === "clipboard-sanitized-write" && isAppUrl(details.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === "clipboard-sanitized-write" && isAppUrl(origin));
  ses.protocol.handle("swan", handleApp);
}

app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // Swan's own pages (attachments) open in a window with the same settings; anything else in the browser.
    if (isAppUrl(url)) return { action: "allow", overrideBrowserWindowOptions: { backgroundColor: BACKGROUND, webPreferences: SAFE_PREFS } };
    openOutside(url);
    return { action: "deny" };
  });
  const keepInApp = (e: Electron.Event, url: string) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openOutside(url);
  };
  contents.on("will-navigate", keepInApp);
  contents.on("will-redirect", keepInApp);
  contents.on("will-attach-webview", (e) => e.preventDefault());
});

function createWindow(): BrowserWindow {
  const stateFile = path.join(app.getPath("userData"), "window.json");
  const state = loadWindowState(stateFile);
  const w = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Swan",
    backgroundColor: BACKGROUND,
    webPreferences: SAFE_PREFS,
  });
  if (state.maximized) w.maximize();
  trackWindowState(w, stateFile);
  w.once("ready-to-show", () => w.show());
  w.on("closed", () => {
    if (win === w) win = null;
  });
  return w;
}

/** A one-line page while the server starts or stops. */
function showStatus(text: string) {
  win ??= createWindow();
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Swan</title><style>html{color-scheme:dark}body{margin:0;height:100vh;display:grid;place-items:center;background:${BACKGROUND};color:#aeb9ca;font:14px system-ui,-apple-system,sans-serif}</style>
<p role="status">${escapeAttr(text)}</p>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function connect(serverUrl: string, serverHome: string) {
  const u = new URL(serverUrl);
  const token = (await fs.readFile(path.join(serverHome, "api-token"), "utf8")).trim();
  api = { origin: u.origin, port: u.port, token };
  home = serverHome;
  win ??= createWindow();
  await win.loadURL(APP_URL);
  if (SMOKE) await smokeCheck();
}

async function launch(): Promise<void> {
  if (DEV_URL) {
    win ??= createWindow();
    return void win.loadURL(DEV_URL);
  }
  showStatus("Starting Swan…");
  shellEnv ??= await loginShellEnv();
  const env = serverEnv(shellEnv ?? process.env, {
    PH_RESOURCES: resources,
    PH_PORT_FALLBACK: "1",
    SWAN_VERSION: app.getVersion(),
    ...(homeOverride ? { PH_HOME: homeOverride } : {}),
  });
  const proc = new ServerProcess({ node: nodeBinary, entry: path.join(resources, "server", "index.mjs"), env, logFile });
  proc.on("exit", (code, signal) => void onServerExit(proc, code, signal));
  server = proc;
  const msg = await proc.start();
  await handle(proc, msg);
}

async function handle(proc: ServerProcess, msg: LauncherMessage): Promise<void> {
  if (msg.type === "ready") return connect(msg.url, msg.home);
  server = null; // it exits after telling us why
  if (SMOKE) return finishSmoke(1, `the server did not start: ${JSON.stringify(msg)}\n${proc.logTail()}`);
  if (msg.type === "home-in-use") {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "Swan is already running",
      detail: msg.url
        ? `Another Swan${msg.pid ? ` (pid ${msg.pid})` : ""} is using ${tildify(msg.home)}. You can use it here; it keeps running when you quit this app.`
        : `Another Swan${msg.pid ? ` (pid ${msg.pid})` : ""} is starting for ${tildify(msg.home)}.`,
      buttons: [msg.url ? "Open It" : "Try Again", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) return app.quit();
    return msg.url ? connect(msg.url, msg.home) : launch();
  }
  return failed(msg.message, proc.logTail());
}

async function failed(message: string, tail: string): Promise<void> {
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: "error",
      message: "Swan could not start",
      detail: `${message}${tail ? `\n\nLast lines of the log:\n${tail.split("\n").slice(-8).join("\n")}` : ""}`,
      buttons: ["Try Again", "Show Log", "Quit"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) return launch();
    if (response === 2) return app.quit();
    await shell.openPath(logFile);
  }
}

/** A crash restarts the server, up to three times a minute; then the user decides. */
async function onServerExit(proc: ServerProcess, code: number | null, signal: NodeJS.Signals | null) {
  if (quitting || server !== proc) return;
  server = null;
  const now = Date.now();
  crashes.push(now);
  while (crashes.length && crashes[0]! < now - 60_000) crashes.shift();
  if (SMOKE) return finishSmoke(1, `the server stopped (${signal ?? code})\n${proc.logTail()}`);
  if (crashes.length <= 3) return launch();
  return failed(`The server stopped ${crashes.length} times in a minute (last: ${signal ?? `exit code ${code}`}).`, proc.logTail());
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Open Data Folder", click: () => void shell.openPath(home) },
        { label: "Show Server Log", click: () => void shell.openPath(logFile) },
        { type: "separator" },
        { label: "Swan on GitHub", click: () => void shell.openExternal(REPO_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const smokeCsp: string[] = [];

/** CI: the page loaded with its token, the API answers through swan://app and directly, the WebSocket opens. */
async function smokeCheck() {
  try {
    const wc = win!.webContents;
    const run = <T>(js: string) => wc.executeJavaScript(js) as Promise<T>;
    const token = api!.token;
    const result = {
      title: await run<string>("document.title"),
      tokenInPage: await run<boolean>(`document.querySelector('meta[name="ph-token"]').content === ${JSON.stringify(token)}`),
      viaApp: await run<number>(`fetch("/api/runtime", { headers: { "x-ph-token": ${JSON.stringify(token)} } }).then((r) => r.status)`),
      direct: (await fetch(`${api!.origin}/api/runtime`, { headers: { "x-ph-token": token } })).status,
      noToken: (await fetch(`${api!.origin}/api/runtime`)).status,
      webSocket: await run<string>(
        `new Promise((resolve) => { const ws = new WebSocket(document.querySelector('meta[name="ph-ws"]').content + "?token=" + ${JSON.stringify(token)}); ws.onopen = () => { ws.close(); resolve("open"); }; ws.onerror = () => resolve("error"); })`,
      ),
      cspViolations: 0,
    };
    await new Promise((r) => setTimeout(r, 2000)); // let the UI render and report problems
    result.cspViolations = smokeCsp.length;
    if (process.env.SWAN_SMOKE_SCREENSHOT) await fs.writeFile(process.env.SWAN_SMOKE_SCREENSHOT, (await wc.capturePage()).toPNG());
    const ok = result.title === "Swan" && result.tokenInPage && result.viaApp === 200 && result.direct === 200 && result.noToken === 401 && result.webSocket === "open" && !smokeCsp.length;
    return finishSmoke(ok ? 0 : 1, `${JSON.stringify(result)}${smokeCsp.length ? `\n${smokeCsp.join("\n")}` : ""}`);
  } catch (e) {
    return finishSmoke(1, String(e));
  }
}

async function finishSmoke(code: number, message: string) {
  (code === 0 ? console.log : console.error)(`SWAN SMOKE ${code === 0 ? "OK" : "FAILED"}: ${message}`);
  quitting = true;
  await server?.stop();
  app.exit(code);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // Quit stops the server first, so its session containers stop and conversations stay resumable.
  app.on("before-quit", (e) => {
    if (!server?.running) return;
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    if (win) showStatus("Stopping Swan…");
    void server.stop().finally(() => app.quit());
  });

  // A signal (logout, `kill`, Ctrl+C in development) quits the same way as Cmd+Q.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => app.quit());

  // macOS: closing the window keeps Swan running; the Dock icon brings it back.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (win) return;
    win = createWindow();
    if (DEV_URL) void win.loadURL(DEV_URL);
    else if (api) void win.loadURL(APP_URL);
    else showStatus("Starting Swan…");
  });

  void app.whenReady().then(async () => {
    buildMenu();
    hardenSession();
    if (SMOKE) {
      setTimeout(() => void finishSmoke(1, "timed out after 120 s"), 120_000).unref();
      app.on("web-contents-created", (_e, contents) =>
        contents.on("console-message", (ev) => {
          if (/Content Security Policy/i.test(ev.message)) smokeCsp.push(ev.message);
        }),
      );
    }
    await launch();
  });
}
