import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { apiGet, apiPost, errorMessage } from "../api/client.js";
import type { CancelRunResponse, RetryRunResponse, RunStatusSummary } from "../api/types.js";
import { RunCountsBar } from "../components/RunCountsBar.js";
import { useInterval } from "../hooks.js";
import { navigate } from "../router.js";

const ACTIVE_STATES = new Set(["pending", "running"]);

export function ProgressScreen({ runId }: { runId: string }): ReactElement {
  const [status, setStatus] = useState<RunStatusSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<RunStatusSummary>(`/api/runs/${runId}/status`);
      setStatus(res.data);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useInterval(() => {
    void refresh();
    setNow(Date.now());
  }, 1500);

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (error && !status) {
    return (
      <section className="card">
        <p className="error-banner">{error}</p>
        <button className="btn" onClick={() => navigate("/")}>
          Home
        </button>
      </section>
    );
  }
  if (!status) return <p className="muted">Loading…</p>;

  const active = ACTIVE_STATES.has(status.status);
  const stuckPending = status.status === "pending" && now - pendingSince > 10_000;

  return (
    <div>
      <div className="page-head">
        <h1>Run progress</h1>
        <button className="btn" onClick={() => navigate("/")}>
          Home
        </button>
      </div>

      <section className="card">
        <div className="row">
          <span className={`chip status-${status.status}`}>{status.status}</span>
          <span className="chip">profile: {status.profile}</span>
          <span className="chip">
            credits: {status.creditsUsed}/{status.creditLimit}
          </span>
          {status.cancelRequested && active && <span className="chip chip-warn">cancel requested…</span>}
        </div>
        {status.pauseReason === "rate_limited" ? (
          <p className="info-banner">
            Paused by a provider rate limit.
            {status.resumeAt
              ? ` Auto-resumes ${new Date(status.resumeAt).getTime() > now ? `in ~${Math.max(1, Math.ceil((new Date(status.resumeAt).getTime() - now) / 1000))}s` : "shortly"} — no new approval is needed (the budget is unchanged).`
              : " It will resume automatically."}
          </p>
        ) : status.pauseReason ? (
          <p className="info-banner">
            Paused: {status.pauseReason}. Resuming without a bigger budget will pause again at the same point; raising
            the budget needs a fresh preview and approval (start a new preview of the widened scope).
          </p>
        ) : null}
        {stuckPending && (
          <p className="info-banner">
            Still pending — the background worker may not have picked this run up. Retry below or check the server log.
          </p>
        )}

        <RunCountsBar counts={status.counts} />

        <h3>Step progress</h3>
        {Object.keys(status.stepProgress).length === 0 ? (
          <p className="muted">Not started yet.</p>
        ) : (
          <ul className="plain-list">
            {Object.entries(status.stepProgress).map(([stepId, marker]) => (
              <li key={stepId}>
                <strong>{stepId}</strong>: {marker}
              </li>
            ))}
          </ul>
        )}

        {status.sourceCoverage.length > 0 && (
          <>
            <h3>Source coverage</h3>
            <ul className="plain-list">
              {status.sourceCoverage.map((c) => (
                <li key={c.descriptor}>
                  <span className={`chip status-${c.status}`}>{c.status}</span> <strong>{c.descriptor}</strong>
                  {c.recordsInserted !== null && <span> — {c.recordsInserted} record(s)</span>}
                  {c.coverageNote && <div className="muted">{c.coverageNote}</div>}
                </li>
              ))}
            </ul>
          </>
        )}

        {status.status === "waiting_review" && (
          <p className="info-banner">
            The run reached its review gate. Review the leads, then continue the run from the results screen.
          </p>
        )}
        {actionError && <p className="error-banner">{actionError}</p>}

        <div className="row">
          {(status.status === "waiting_review" || status.status === "completed") && (
            <button className="btn btn-primary" onClick={() => navigate(`/runs/${runId}/results`)}>
              Review results
            </button>
          )}
          {status.status === "paused" && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => void act(async () => void (await apiPost(`/api/runs/${runId}/resume`, {})))}
            >
              Resume
            </button>
          )}
          {status.status === "failed" && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => void act(async () => void (await apiPost<RetryRunResponse>(`/api/runs/${runId}/retry`, {})))}
            >
              Retry failed items
            </button>
          )}
          {(active || status.status === "waiting_review" || status.status === "paused") && (
            <button
              className="btn btn-danger"
              disabled={busy || status.cancelRequested}
              onClick={() => void act(async () => void (await apiPost<CancelRunResponse>(`/api/runs/${runId}/cancel`, {})))}
            >
              Cancel run
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
