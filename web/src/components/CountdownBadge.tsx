import type { ReactElement } from "react";
import { useEffect, useState } from "react";

/** Ticks down to the approval token's expiry; fires onExpired once at zero. */
export function CountdownBadge({ expiresAt, onExpired }: { expiresAt: string; onExpired: () => void }): ReactElement {
  const [remainingMs, setRemainingMs] = useState(() => new Date(expiresAt).getTime() - Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      setRemainingMs(new Date(expiresAt).getTime() - Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const expired = remainingMs <= 0;
  useEffect(() => {
    if (expired) onExpired();
    // onExpired identity changes are irrelevant; fire once per expiry flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);

  if (expired) return <span className="chip chip-warn">approval expired — preview again</span>;
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return (
    <span className="chip chip-ok">
      approval valid for {minutes}:{seconds.toString().padStart(2, "0")}
    </span>
  );
}
