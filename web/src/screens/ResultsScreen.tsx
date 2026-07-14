import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { apiGet, apiPost, errorMessage } from "../api/client.js";
import type { ResultPhone, ResultsPage, RunItemResult, RunStatusSummary, WebExportResult } from "../api/types.js";
import { navigate } from "../router.js";

/** Honest validation label: exactly what was checked, never a bare 'verified'. */
function describeValidation(phone: ResultPhone): string {
  switch (phone.validationLevel) {
    case "identity_match":
      return `identity ${phone.identityMatch ?? "unknown"}`;
    case "line_status":
      return `line ${phone.lineStatus ?? "unknown"}`;
    case "format":
      return "format-only";
    default:
      return "unchecked";
  }
}

type ReviewFilter = "" | "unreviewed" | "approved" | "rejected" | "regenerate";
type StatusFilter = "" | "pending" | "in_progress" | "completed" | "failed" | "skipped";

export function ResultsScreen({ runId }: { runId: string }): ReactElement {
  const [status, setStatus] = useState<RunStatusSummary | null>(null);
  const [items, setItems] = useState<RunItemResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportResult, setExportResult] = useState<WebExportResult | null>(null);

  const query = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (reviewFilter) params.set("reviewStatus", reviewFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (cursor) params.set("cursor", cursor);
      return `/api/runs/${runId}/results?${params.toString()}`;
    },
    [runId, reviewFilter, statusFilter],
  );

  const refresh = useCallback(async () => {
    try {
      const [statusRes, resultsRes] = await Promise.all([
        apiGet<RunStatusSummary>(`/api/runs/${runId}/status`),
        apiGet<ResultsPage<RunItemResult>>(query()),
      ]);
      setStatus(statusRes.data);
      setItems(resultsRes.data.items);
      setNextCursor(resultsRes.data.page.nextCursor);
      setTotal(resultsRes.data.page.total);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [runId, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const res = await apiGet<ResultsPage<RunItemResult>>(query(nextCursor));
      setItems((prev) => [...prev, ...res.data.items]);
      setNextCursor(res.data.page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const review = (decision: "approved" | "rejected" | "regenerate", ids: string[] | "all"): Promise<void> =>
    act(async () => {
      await apiPost(`/api/runs/${runId}/review`, ids === "all" ? { decision, all: true } : { decision, itemIds: ids });
      setSelected(new Set());
    });

  const regenerateSelected = (ids: string[]): Promise<void> =>
    act(async () => {
      await apiPost(`/api/runs/${runId}/review`, { decision: "regenerate", itemIds: ids });
      // run retry re-runs generation for the marked items (free of engine credits).
      await apiPost(`/api/runs/${runId}/retry`, {});
      setSelected(new Set());
    });

  const suppressSelected = (ids: string[]): Promise<void> =>
    act(async () => {
      const chosen = items.filter((i) => ids.includes(i.runItemId) && i.leadId);
      for (const item of chosen) {
        await apiPost("/api/suppressions", {
          scope: "lead",
          value: item.leadId as string,
          reason: `suppressed from results of run ${runId}`,
        });
      }
      setSelected(new Set());
    });

  const continueSelected = (ids: string[]): Promise<void> =>
    act(async () => {
      // The engine continues APPROVED rows: approve the selection first, then
      // open the continuation wizard (same preview → approval path).
      if (ids.length > 0) {
        await apiPost(`/api/runs/${runId}/review`, { decision: "approved", itemIds: ids });
      }
      navigate(`/new/continue/${runId}`);
    });

  const continueRun = (): Promise<void> =>
    act(async () => {
      await apiPost(`/api/runs/${runId}/resume`, {});
      navigate(`/runs/${runId}`);
    });

  const doExport = (): Promise<void> =>
    act(async () => {
      const res = await apiPost<WebExportResult>(`/api/runs/${runId}/export`, {});
      setExportResult(res.data);
    });

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectable = items.filter((i) => i.status !== "skipped").map((i) => i.runItemId);
  const selectedIds = [...selected];

  return (
    <div>
      <div className="page-head">
        <h1>Results</h1>
        <span>
          <button className="btn" onClick={() => navigate(`/runs/${runId}`)}>
            Progress
          </button>{" "}
          <button className="btn" onClick={() => navigate("/")}>
            Home
          </button>
        </span>
      </div>

      {status && (
        <section className="card">
          <div className="row">
            <span className={`chip status-${status.status}`}>{status.status}</span>
            <span className="chip">
              {status.counts.approved} approved · {status.counts.rejected} rejected · {status.counts.unreviewed}{" "}
              unreviewed
            </span>
            <span className="chip">
              credits {status.creditsUsed}/{status.creditLimit}
            </span>
          </div>
          {status.status === "waiting_review" && (
            <p className="info-banner">
              Review below, then continue the run — export only includes approved, completed leads.
            </p>
          )}
          {status.sourceCoverage.some((c) => c.coverageNote) && (
            <p className="muted">
              {status.sourceCoverage
                .filter((c) => c.coverageNote)
                .map((c) => c.coverageNote)
                .join(" ")}
            </p>
          )}
        </section>
      )}
      {error && <p className="error-banner">{error}</p>}

      <section className="card">
        <div className="row row-between">
          <span>
            <label>
              Review:{" "}
              <select value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)}>
                <option value="">all</option>
                <option value="unreviewed">unreviewed</option>
                <option value="approved">approved</option>
                <option value="rejected">rejected</option>
                <option value="regenerate">regenerate</option>
              </select>
            </label>{" "}
            <label>
              Status:{" "}
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
                <option value="">all</option>
                <option value="completed">completed</option>
                <option value="failed">failed</option>
                <option value="skipped">skipped</option>
                <option value="pending">pending</option>
                <option value="in_progress">in progress</option>
              </select>
            </label>
          </span>
          <span className="muted">
            {items.length} of {total} shown
          </span>
        </div>

        <div className="row">
          <button className="btn btn-small" onClick={() => setSelected(new Set(selectable))}>
            Select all loaded
          </button>
          <button className="btn btn-small" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
          <button
            className="btn btn-small"
            disabled={busy || selectedIds.length === 0}
            onClick={() => void review("approved", selectedIds)}
          >
            Approve selected ({selectedIds.length})
          </button>
          <button
            className="btn btn-small"
            disabled={busy || selectedIds.length === 0}
            onClick={() => void review("rejected", selectedIds)}
          >
            Reject selected
          </button>
          <button className="btn btn-small" disabled={busy} onClick={() => void review("approved", "all")}>
            Approve all items
          </button>
          <button className="btn btn-small" disabled={busy} onClick={() => void review("rejected", "all")}>
            Reject all items
          </button>
          <button
            className="btn btn-small"
            disabled={busy || selectedIds.length === 0}
            title="Re-runs the generate step for the selected leads (free) and returns them to the review queue"
            onClick={() => void regenerateSelected(selectedIds)}
          >
            Regenerate copy
          </button>
          <button
            className="btn btn-small"
            disabled={busy || selectedIds.length === 0}
            title="Adds the selected leads to the do-not-contact list (applied live before every call-ready export)"
            onClick={() => void suppressSelected(selectedIds)}
          >
            Suppress selected
          </button>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th></th>
              <th>Business</th>
              <th>Category</th>
              <th>Website</th>
              <th>Locality</th>
              <th>Phones (role · checked)</th>
              <th>Email</th>
              <th>Owner</th>
              <th>Score</th>
              <th>Call-ready</th>
              <th>Status</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.runItemId} className={item.status === "skipped" ? "row-muted" : ""}>
                <td>
                  <input
                    type="checkbox"
                    disabled={item.status === "skipped"}
                    checked={selected.has(item.runItemId)}
                    onChange={() => toggle(item.runItemId)}
                  />
                </td>
                <td>
                  {item.business?.name ?? item.sourceKey}
                  {item.suppressed && <span className="chip review-rejected"> suppressed</span>}
                </td>
                <td>{item.business?.category ?? "—"}</td>
                <td>
                  {item.business?.website ? (
                    <a href={item.business.website} target="_blank" rel="noreferrer">
                      {item.business.website.replace(/^https?:\/\//, "")}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{item.business?.locality ?? "—"}</td>
                <td>
                  {item.phones.length === 0
                    ? (item.business?.businessMainPhone ?? "—")
                    : item.phones.map((phone) => (
                        <div key={`${item.runItemId}-${phone.role}-${phone.e164 ?? "raw"}`} className={phone.suppressed ? "row-muted" : ""}>
                          {phone.e164 ?? "unparseable"}{" "}
                          <span className="muted">
                            {phone.role}
                            {phone.lineType ? ` · ${phone.lineType}` : ""} · {describeValidation(phone)}
                            {phone.suppressed ? " · SUPPRESSED" : ""}
                          </span>
                        </div>
                      ))}
                </td>
                <td>
                  {item.email?.address ? (
                    <>
                      {item.email.address} <span className="muted">[{item.email.status ?? "not_checked"}]</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{item.owner ? `${item.owner.name}${item.owner.title ? `, ${item.owner.title}` : ""}` : "—"}</td>
                <td>{item.score ?? "—"}</td>
                <td>
                  {item.callReadinessStatus ? (
                    <span className={`chip readiness-${item.callReadinessStatus}`} title={item.callReadinessReason ?? ""}>
                      {item.callReadinessStatus}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <span className={`chip status-${item.status}`}>{item.status}</span>
                  {item.skipReason && <span className="muted"> {item.skipReason}</span>}
                </td>
                <td>
                  <span className={`chip review-${item.reviewStatus}`}>{item.reviewStatus}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {nextCursor && (
          <button className="btn" onClick={() => void loadMore()}>
            Load more
          </button>
        )}
      </section>

      <section className="card">
        <h2>Continue & export</h2>
        <div className="row">
          {status?.status === "waiting_review" && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void continueRun()}>
              Continue run past review gate
            </button>
          )}
          <button
            className="btn"
            disabled={busy}
            title="Approves the current selection (if any) and opens a new call-ready run over this run's APPROVED leads — no re-sourcing"
            onClick={() => void continueSelected(selectedIds)}
          >
            Continue {selectedIds.length > 0 ? `selected (${selectedIds.length})` : "approved leads"} into deeper enrichment
          </button>
          <button className="btn" disabled={busy} onClick={() => void doExport()}>
            Export approved leads to CSV
          </button>
        </div>
        {exportResult && (
          <p className="info-banner">
            {exportResult.noop ? "Export unchanged since last time. " : `Exported ${exportResult.rowCount} row(s). `}
            <a href={exportResult.downloadUrl}>Download {exportResult.fileName}</a>
          </p>
        )}
        <p className="muted">
          Export requires the review gate to be passed and includes only approved, completed leads; call-readiness
          'invalid' and suppressed rows are excluded from the call-ready CSV (kept here). Deeper enrichment opens a new
          run with its own preview and approval.
        </p>
      </section>
    </div>
  );
}
