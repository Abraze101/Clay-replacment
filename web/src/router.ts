import { useEffect, useState } from "react";

// Hand-rolled hash routing: four routes, no SPA fallback rewrites needed in
// the static server, and no router dependency for a wizard-sized app.
export type Route =
  | { name: "home" }
  | { name: "new"; continueFrom?: string }
  | { name: "providers" }
  | { name: "run"; runId: string }
  | { name: "results"; runId: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const seg = path.split("/").filter((s) => s.length > 0);
  if (seg.length === 0) return { name: "home" };
  if (seg[0] === "new") {
    // #/new/continue/<runId>: seed the wizard for selected-lead continuation.
    if (seg[1] === "continue" && seg[2] !== undefined) return { name: "new", continueFrom: seg[2] };
    return { name: "new" };
  }
  if (seg[0] === "providers") return { name: "providers" };
  if (seg[0] === "runs" && seg[1] !== undefined) {
    if (seg[2] === "results") return { name: "results", runId: seg[1] };
    return { name: "run", runId: seg[1] };
  }
  return { name: "home" };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(to: string): void {
  window.location.hash = to;
}
