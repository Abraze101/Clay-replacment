import type { ReactElement } from "react";

import type { PlannedStep } from "../api/types.js";

export function PlanStepsTable({ steps }: { steps: PlannedStep[] }): ReactElement {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Step</th>
          <th>Type</th>
          <th>Provider</th>
          <th>Cost</th>
          <th>Runs?</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((step) => (
          <tr key={step.id} className={step.willRun ? "" : "row-muted"}>
            <td>{step.id}</td>
            <td>{step.type}</td>
            <td>{step.provider ?? "—"}</td>
            <td>
              {step.paid ? (
                <span className="chip chip-paid">paid · {step.costPerRecord}/record</span>
              ) : (
                <span className="chip chip-free">free</span>
              )}
            </td>
            <td>
              {step.willRun ? (
                <span className="chip chip-ok">yes</span>
              ) : (
                <span className="chip chip-muted">skipped by {step.excludedBy ?? "plan"}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
