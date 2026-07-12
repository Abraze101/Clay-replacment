import type { ReactElement } from "react";

import type { RunStatusSummary } from "../api/types.js";

export function RunCountsBar({ counts }: { counts: RunStatusSummary["counts"] }): ReactElement {
  const entries: [string, number][] = [
    ["sourced", counts.items],
    ["completed", counts.completed],
    ["in progress", counts.inProgress],
    ["pending", counts.pending],
    ["failed", counts.failed],
    ["filtered out", counts.filtered],
    ["identity conflicts", counts.identityConflicts],
    ["skipped", counts.skipped],
    ["approved", counts.approved],
    ["rejected", counts.rejected],
    ["unreviewed", counts.unreviewed],
  ];
  return (
    <div className="counts-bar">
      {entries
        .filter(([label, value]) => value > 0 || label === "sourced" || label === "completed")
        .map(([label, value]) => (
          <span key={label} className="count-chip">
            <strong>{value}</strong> {label}
          </span>
        ))}
      {counts.stepsNeedingReview > 0 && (
        <span className="count-chip chip-warn">
          <strong>{counts.stepsNeedingReview}</strong> paid step(s) need manual review
        </span>
      )}
    </div>
  );
}
