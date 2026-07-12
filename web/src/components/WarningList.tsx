import type { ReactElement } from "react";

export function WarningList({ warnings }: { warnings: string[] }): ReactElement | null {
  if (warnings.length === 0) return null;
  return (
    <ul className="warning-list">
      {warnings.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}
