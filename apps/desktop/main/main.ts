import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebPreferences, app, dialog, powerMonitor, protocol, session, shell } from "electron";
import type { LauncherMessage } from "@ph/shared";
import { appCsp, resolveUiFile, uiContentType } from "./app-protocol.js";
import { connectPage, readConnectUrl } from "./remote-page.js";
import { type RemoteServer, type ServerChoice, SshTunnel, freePort, loadChoice, readRemoteToken, saveChoice, tunnelArgs, waitForServer } from "./remote.js";
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
// A Swan on another machine, through `ssh -L` on a local port that stays the same for the app's lifetime.
let tunnel: SshTunnel | null = null;
let tunnelPort: number | null = null;
let remoteHost: string | null = null; // the host the window is on, null for this Mac
let generation = 0; // bumped on every (re)launch and switch, so a stale attempt stops quietly
let connectWin: BrowserWindow | null = null;
const choiceFile = () => path.join(app.getPath("userData"), "server.json");

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
    .replace("__PH_WS__", escapeAttr(`ws://127.0.0.1:${api.port}/api/ws`))
    .replace("__PH_SERVER__", escapeAttr(remoteHost ?? ""));
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
    // No title bar: Swan's header takes its place, with the window buttons centred on it (50 px).
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: SAFE_PREFS,
  });
  if (state.maximized) w.maximize();
  // The title (Window menu, Mission Control) says which machine the window is on.
  w.on("page-title-updated", (e, title) => {
    if (!remoteHost) return;
    e.preventDefault();
    w.setTitle(`${title} — ${remoteHost}`);
  });
  trackWindowState(w, stateFile);
  // The page leaves room for the window buttons, except in full screen where macOS hides them.
  const markButtons = () => {
    if (isAppUrl(w.webContents.getURL()))
      void w.webContents.executeJavaScript(`document.documentElement.classList.toggle("window-buttons", ${!w.isFullScreen()})`).catch(() => {});
  };
  w.webContents.on("did-finish-load", markButtons);
  w.on("enter-full-screen", markButtons);
  w.on("leave-full-screen", markButtons);
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
<title>Swan</title><style>html{color-scheme:dark}body{margin:0;height:100vh;display:grid;place-items:center;background:${BACKGROUND};color:#aeb9ca;font:14px system-ui,-apple-system,sans-serif;-webkit-app-region:drag}</style>
<p role="status">${escapeAttr(text)}</p>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function connect(serverUrl: string, serverHome: string) {
  const token = (await fs.readFile(path.join(serverHome, "api-token"), "utf8")).trim();
  home = serverHome;
  return openUi(serverUrl, token);
}

async function openUi(serverUrl: string, token: string) {
  const u = new URL(serverUrl);
  api = { origin: u.origin, port: u.port, token };
  win ??= createWindow();
  await win.loadURL(APP_URL);
  if (SMOKE) await smokeCheck();
}

async function launch(): Promise<void> {
  if (DEV_URL) {
    win ??= createWindow();
    return void win.loadURL(DEV_URL);
  }
  const gen = ++generation;
  const choice = await loadChoice(choiceFile());
  if (gen !== generation) return;
  if (choice.use === "remote" && choice.remote) return launchRemote(choice.remote, gen);
  remoteHost = null;
  buildMenu();
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
  if (gen !== generation) return; // switched to another server meanwhile
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

/** The UI on a remote Swan: read its token, open the tunnel, wait for the API, then load as usual. */
async function launchRemote(r: RemoteServer, gen: number): Promise<void> {
  remoteHost = r.host;
  buildMenu();
  showStatus(`Connecting to ${r.host}…`);
  const read = await readRemoteToken(r);
  if (gen !== generation) return;
  if ("error" in read) return remoteFailed(r, gen, read.error, read.detail);
  tunnelPort ??= await freePort();
  const origin = `http://127.0.0.1:${tunnelPort}`;
  const t = new SshTunnel({ args: tunnelArgs(r, tunnelPort) });
  tunnel = t;
  t.start();
  const problem = await waitForServer({ origin, token: read.token, tunnel: t, host: r.host });
  if (gen !== generation) return t.stop();
  if (problem) {
    t.stop();
    tunnel = null;
    return remoteFailed(r, gen, problem.error, problem.detail);
  }
  // From here a dropped ssh comes back by itself; tell the page as soon as the API answers again.
  t.on("spawn", () => void nudgeWhenUp(t, origin, read.token));
  return openUi(origin, read.token);
}

/** The page's WebSocket retries with backoff up to 15 s; an "online" event makes it retry now. */
async function nudgeWhenUp(t: SshTunnel, origin: string, token: string) {
  const exits = t.exits;
  for (let i = 0; i < 60 && t === tunnel && t.exits === exits; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const ok = await fetch(`${origin}/api/runtime`, { headers: { "x-ph-token": token }, signal: AbortSignal.timeout(3000) }).then(
      (res) => res.ok,
      () => false,
    );
    if (ok) return void win?.webContents.executeJavaScript(`window.dispatchEvent(new Event("online"))`).catch(() => {});
  }
}

async function remoteFailed(r: RemoteServer, gen: number, message: string, detail: string): Promise<void> {
  showStatus(`Not connected to ${r.host}`);
  const { response } = await dialog.showMessageBox({
    type: "error",
    message: `Couldn't connect to ${r.host}`,
    detail: `${message}${detail ? `\n\nssh said:\n${detail}` : ""}`,
    buttons: ["Try Again", "Change Server…", "Use This Mac", "Quit"],
    defaultId: 0,
    cancelId: 3,
  });
  if (gen !== generation) return;
  if (response === 0) return launch();
  if (response === 1) return openConnectWindow();
  if (response === 2) return switchServer({ use: "local", remote: r });
  app.quit();
}

/** Save the choice and start over on that server. Leaving this Mac stops its server (and its sandboxes). */
async function switchServer(choice: ServerChoice): Promise<void> {
  await saveChoice(choiceFile(), choice);
  generation++;
  tunnel?.stop();
  tunnel = null;
  api = null;
  const s = server;
  server = null;
  if (s?.running) {
    showStatus("Stopping Swan…");
    await s.stop();
  }
  await launch();
}

/** "Connect to Remote Swan…": a small form; submitting it navigates to a URL the window catches. */
async function openConnectWindow() {
  if (connectWin) return connectWin.focus();
  const choice = await loadChoice(choiceFile());
  const w = new BrowserWindow({
    width: 460,
    height: 430,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    title: "Connect to Remote Swan",
    backgroundColor: BACKGROUND,
    ...(win ? { parent: win, modal: true } : {}),
    webPreferences: SAFE_PREFS,
  });
  connectWin = w;
  const load = (html: string) => void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  w.webContents.on("will-navigate", (e, url) => {
    const answer = readConnectUrl(url);
    if (!answer) return;
    e.preventDefault();
    if (answer.use === "invalid") return load(connectPage(choice, answer.error, answer.values));
    w.close();
    if (answer.use === "remote") void switchServer({ use: "remote", remote: answer.remote });
    else if (answer.use === "local" && choice.use === "remote") void switchServer({ use: "local", ...(choice.remote ? { remote: choice.remote } : {}) });
  });
  w.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      e.preventDefault();
      w.close();
    }
  });
  w.once("ready-to-show", () => w.show());
  w.on("closed", () => {
    if (connectWin === w) connectWin = null;
  });
  load(connectPage(choice));
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Connect to Remote Swan…", click: () => void openConnectWindow() },
        {
          label: "Use This Mac",
          enabled: !!remoteHost,
          click: () => void loadChoice(choiceFile()).then((c) => switchServer({ use: "local", ...(c.remote ? { remote: c.remote } : {}) })),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
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
        // On a remote Swan both are on the other machine.
        { label: "Open Data Folder", enabled: !remoteHost, click: () => void shell.openPath(home) },
        { label: "Show Server Log", enabled: !remoteHost, click: () => void shell.openPath(logFile) },
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
    tunnel?.stop(); // a remote Swan keeps running; only the tunnel goes
    if (!server?.running) return;
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    if (win) showStatus("Stopping Swan…");
    void server.stop().finally(() => app.quit());
  });

  // A signal (logout, `kill`, Ctrl+C in development) quits the same way as Cmd+Q.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => app.quit());
  process.on("exit", () => tunnel?.stop());

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
    // After sleep the ssh connection is usually dead: reconnect now instead of after the keepalives fail.
    powerMonitor.on("resume", () => tunnel?.wake());
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
