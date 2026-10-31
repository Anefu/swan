import type { DeviceCode } from "@ph/shared";
import { useNow } from "../util";
import { CopyButton, Spinner } from "./ui";

/** Only http(s) links from a wrapper become clickable. */
function safeUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function minutesLeft(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round((t - now) / 60_000);
}

/** A device-code sign-in: the code, Copy, Open link and Cancel. `code` null = still waiting for the wrapper. */
export function DeviceCodePanel({ code, onCancel, busy }: { code: DeviceCode | null; onCancel: () => void; busy?: boolean }) {
  const now = useNow(15_000);
  if (!code) {
    return (
      <div className="row gap small">
        <Spinner size={10} />
        <span className="grow muted">Getting a code…</span>
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    );
  }
  const url = safeUrl(code.verificationUriComplete ?? code.verificationUri);
  const host = safeUrl(code.verificationUri) ? new URL(code.verificationUri).host : null;
  const mins = minutesLeft(code.expiresAt, now);
  return (
    <div className="device">
      <p className="small muted">Enter this code{host ? ` at ${host}` : ""}. Only you see it.</p>
      <p className="device-code">{code.userCode}</p>
      <div className="row gap wrap">
        <CopyButton text={code.userCode} label="Copy code" showLabel />
        {url && (
          <a className="btn sm" href={url} target="_blank" rel="noopener noreferrer">
            Open link
          </a>
        )}
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {mins !== null && (
        <p className="hint">
          {mins <= 0 ? "This code has expired; cancel and sign in again." : mins < 90 ? `Expires in ${mins} min.` : `Expires in ${Math.round(mins / 60)} h.`}
        </p>
      )}
    </div>
  );
}
