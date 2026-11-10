import { Empty } from "../ui";

export function Unavailable({ what, error, missing, onRetry }: { what: string; error: string; missing: boolean; onRetry: () => void }) {
  return (
    <Empty
      title={missing ? `${what} is not available from this server yet` : `Could not load ${what.toLowerCase()}`}
      action={
        !missing && (
          <button type="button" className="btn sm" onClick={onRetry}>
            Try again
          </button>
        )
      }
    >
      {!missing && error}
    </Empty>
  );
}
