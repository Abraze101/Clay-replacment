import type { ReactElement } from "react";
import { useState } from "react";

import { ApiError, apiPost, errorMessage } from "../api/client.js";
import type { StartRunResponse } from "../api/types.js";
import { CountdownBadge } from "../components/CountdownBadge.js";
import { PlanStepsTable } from "../components/PlanStepsTable.js";
import { WarningList } from "../components/WarningList.js";
import { navigate } from "../router.js";
import type { NewRunFlow } from "../state/newRunFlow.js";

/**
 * Step 3: the resolved plan and the explicit approval. Approving sends the
 * single-use token from this preview back with the identical options; the
 * engine rejects it if anything about the scope changed or it expired.
 */
export function PreviewScreen({ flow, onBack }: { flow: NewRunFlow; onBack: () => void }): ReactElement {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const preview = flow.preview;
  const options = flow.previewOptions;
  if (!preview || !options) {
    return (
      <section className="card">
        <p className="muted">No preview held — go back and resolve the plan first.</p>
        <button className="btn" onClick={onBack}>
          Back
        </button>
      </section>
    );
  }
  const plan = preview.plan;

  const start = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      const res = await apiPost<StartRunResponse>(`/api/workflows/${flow.fields.workflowSlug}/start`, {
        ...options,
        approval: preview.approval.token,
      });
      navigate(`/runs/${res.data.runId}`);
    } catch (err) {
      if (err instanceof ApiError && err.code.startsWith("APPROVAL_")) {
        setError(`${err.message} Preview again to get a fresh approval.`);
        flow.clearPreview();
      } else {
        setError(errorMessage(err));
      }
      setStarting(false);
    }
  };

  const paidActions = plan.estimatedPaidActions;
  return (
    <div>
      <section className="card">
        <h2>3 · Preview & approve</h2>
        <div className="row">
          <span className="chip">profile: {plan.profile}</span>
          <span className="chip">up to {plan.sourceLimit} sourced leads</span>
          <span className="chip">paid record cap: {plan.paidRecordCap}</span>
          <span className="chip">budget: {plan.creditLimit} credits</span>
          <CountdownBadge expiresAt={preview.approval.expiresAt} onExpired={() => setExpired(true)} />
        </div>

        <h3>Steps that will run</h3>
        <PlanStepsTable steps={plan.steps} />

        <h3>Estimated paid actions</h3>
        {paidActions.length === 0 ? (
          <p className="muted">None — this plan spends no credits.</p>
        ) : (
          <ul className="plain-list">
            {paidActions.map((action) => (
              <li key={action.stepId}>
                <strong>{action.stepId}</strong> via {action.provider}: up to {action.count} records ×{" "}
                {action.costPerRecord} = {action.count * action.costPerRecord} credits
              </li>
            ))}
          </ul>
        )}
        <p>
          <strong>Estimated total: {plan.estimatedCost} credits.</strong>{" "}
          <span className="muted">The run pauses if it reaches the budget.</span>
        </p>

        <WarningList warnings={plan.warnings} />
        {error && <p className="error-banner">{error}</p>}

        <div className="row row-between">
          <button className="btn" onClick={onBack}>
            Back (discards this approval)
          </button>
          <button className="btn btn-primary" disabled={starting || expired} onClick={() => void start()}>
            {starting ? "Starting…" : expired ? "Approval expired" : "Approve & start"}
          </button>
        </div>
        {expired && (
          <p className="muted">
            The approval token expired before you started the run.{" "}
            <button className="btn btn-small" onClick={onBack}>
              Preview again
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
