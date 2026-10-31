import { useEffect, useState } from "react";

/** A load in flight, failed (with the error it failed with) or done. */
export type Load<T> = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; data: T };

/** Run `load` on mount and whenever `deps` change; a result that arrives after a newer request started is dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    let current = true;
    setState((s) => (s.status === "loading" ? s : { status: "loading" }));
    load().then(
      (data) => current && setState({ status: "ready", data }),
      (error: unknown) => current && setState({ status: "error", error }),
    );
    return () => {
      current = false;
    };
    // `deps` is the caller's list of what `load` depends on.
  }, deps);
  return state;
}
