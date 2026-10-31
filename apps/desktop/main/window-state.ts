import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import { type BrowserWindow, type Rectangle, screen } from "electron";

export interface WindowState {
  bounds: { x?: number; y?: number; width: number; height: number };
  maximized: boolean;
}

const DEFAULT: WindowState = { bounds: { width: 1280, height: 860 }, maximized: false };

const overlaps = (a: Rectangle, b: Rectangle) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The last size and position; the position only while it is still on a connected display. */
export function loadWindowState(file: string): WindowState {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<WindowState>;
    const b = s.bounds;
    if (!b || typeof b.width !== "number" || typeof b.height !== "number") return DEFAULT;
    const placed = typeof b.x === "number" && typeof b.y === "number";
    const visible = placed && screen.getAllDisplays().some((d) => overlaps(d.workArea, b as Rectangle));
    return { bounds: visible ? b : { width: b.width, height: b.height }, maximized: !!s.maximized };
  } catch {
    return DEFAULT;
  }
}

export function trackWindowState(w: BrowserWindow, file: string): void {
  const current = (): WindowState => ({ bounds: w.getNormalBounds(), maximized: w.isMaximized() });
  let timer: NodeJS.Timeout | undefined;
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!w.isDestroyed()) void fs.writeFile(file, JSON.stringify(current())).catch(() => {});
    }, 500);
  };
  w.on("resize", saveSoon);
  w.on("move", saveSoon);
  w.on("close", () => {
    clearTimeout(timer);
    try {
      writeFileSync(file, JSON.stringify(current()));
    } catch {
      // not worth failing a close over
    }
  });
}
