import { useEffect, useState } from "react";
import { errorMessage, isMissingEndpoint } from "./util";

/** Load something for the pane; refetch on deps; keep the previous value when a refresh fails. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((v) => {
        if (!alive) return;
        setData(v);
        setError(null);
        setMissing(false);
      })
      .catch((e) => {
        if (!alive) return;
        setMissing(isMissingEndpoint(e));
        setError(errorMessage(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, setData, error, missing, loading, reload: () => setTick((t) => t + 1) };
}
