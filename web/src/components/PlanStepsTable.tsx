import type { ReactElement } from "react";

import type { PlannedStep } from "../api/types.js";

/** Plain-language explanation of what a contact-capability step checks — and what 'valid' means. */
const CAPABILITY_LABELS: Record<string, string> = {
  phone_discovery: "finds direct/mobile numbers",
  phone_validation: "checks line status — format-only is never called verified",
  email_discovery: "finds work emails (enter as not-checked)",
  email_verification: "deliverability check — only 'valid' marks an email verified",
};

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
            <td>
              {step.id}
              {step.capability && <div className="muted">{CAPABILITY_LABELS[step.capability]}</div>}
            </td>
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
                <span className="chip chip-ok">{step.includedBy === "override" ? "yes (your override)" : "yes"}</span>
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
