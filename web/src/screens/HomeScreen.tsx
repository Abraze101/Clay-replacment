import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { apiGet, apiPost, errorMessage } from "../api/client.js";
import type { ProviderStatusInfo, RunListItem, WorkflowCreateResponse, WorkflowSummary } from "../api/types.js";
import { ProviderStatusPanel } from "../components/ProviderStatusPanel.js";
import { navigate } from "../router.js";

export function HomeScreen(): ReactElement {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [providers, setProviders] = useState<ProviderStatusInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [runsRes, workflowsRes, providersRes] = await Promise.all([
        apiGet<{ runs: RunListItem[] }>("/api/runs"),
        apiGet<{ workflows: WorkflowSummary[] }>("/api/workflows"),
        apiGet<{ providers: ProviderStatusInfo[] }>("/api/providers"),
      ]);
      setRuns(runsRes.data.runs);
      setWorkflows(workflowsRes.data.workflows);
      setProviders(providersRes.data.providers);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const seedTemplate = async (): Promise<void> => {
    setSeeding(true);
    try {
      await apiPost<WorkflowCreateResponse>("/api/workflows", { template: "local-service-demo" });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>Lead Engine</h1>
        <button className="btn btn-primary" onClick={() => navigate("/new")}>
          New lead list
        </button>
      </div>
      {error && <p className="error-banner">{error}</p>}

      <section className="card">
        <h2>Recent runs</h2>
        {runs === null ? (
          <p className="muted">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="muted">No runs yet. Start with “New lead list”.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Profile</th>
                <th>Status</th>
                <th>Credits</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td>{run.workflowName}</td>
                  <td>{run.profile}</td>
                  <td>
                    <span className={`chip status-${run.status}`}>{run.status}</span>
                    {run.pauseReason && <span className="muted"> ({run.pauseReason})</span>}
                  </td>
                  <td>
                    {run.creditsUsed}/{run.creditLimit}
                  </td>
                  <td>{run.createdAt ? new Date(run.createdAt).toLocaleString() : "—"}</td>
                  <td>
                    <button className="btn btn-small" onClick={() => navigate(`/runs/${run.runId}`)}>
                      Open
                    </button>
                    <button className="btn btn-small" onClick={() => navigate(`/runs/${run.runId}/results`)}>
                      Results
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Saved templates</h2>
        {workflows === null ? (
          <p className="muted">Loading…</p>
        ) : workflows.length === 0 ? (
          <p>
            <span className="muted">No workflows yet. </span>
            <button className="btn" disabled={seeding} onClick={() => void seedTemplate()}>
              {seeding ? "Seeding…" : "Seed the demo template"}
            </button>
          </p>
        ) : (
          <ul className="plain-list">
            {workflows.map((wf) => (
              <li key={wf.id}>
                <strong>{wf.name}</strong> <span className="muted">({wf.slug}, v{wf.latestVersion ?? "—"})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="row row-between">
          <h2>Providers</h2>
          <button className="btn btn-small" onClick={() => navigate("/providers")}>
            Provider setup
          </button>
        </div>
        <ProviderStatusPanel providers={providers ?? []} />
      </section>
    </div>
  );
}
