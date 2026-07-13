import type { ReactElement } from "react";
import { useState } from "react";

import { apiPost, errorMessage } from "../api/client.js";
import type { InterpretedRequest, TemplateSummary, WorkflowSummary } from "../api/types.js";
import type { NewRunFields, NewRunFlow } from "../state/newRunFlow.js";

/**
 * Step 1: plain English in, editable fields out. Interpretation is a
 * deterministic rule-based parser on the server (no model provider until M5);
 * its suggestions only pre-fill the form below and everything stays editable.
 */
export function GuidedRequestScreen({
  flow,
  workflows,
  templates,
  onSeed,
  seeding,
  sourceProvider,
  onNext,
}: {
  flow: NewRunFlow;
  workflows: WorkflowSummary[] | null;
  templates: TemplateSummary[];
  onSeed: (templateId: string) => void;
  seeding: string | null;
  /** The selected workflow's source provider (drives import-specific inputs). */
  sourceProvider: string;
  onNext: () => void;
}): ReactElement {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { fields } = flow;

  const interpret = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<InterpretedRequest>("/api/interpret", { text });
      applyInterpretation(flow, res.data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const interpretation = flow.interpretation;
  const canContinue = fields.workflowSlug.length > 0;

  return (
    <div>
      <section className="card">
        <h2>1 · Describe what you want</h2>
        <p className="muted">
          For example: “Find 500 roofing companies around Dallas with working websites and public phone numbers.”
          You can also skip this and fill the fields directly.
        </p>
        <textarea
          className="request-box"
          rows={3}
          value={text}
          placeholder="Describe the market, geography, quantity, and what contact info you need…"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row">
          <button className="btn" disabled={busy || text.trim().length === 0} onClick={() => void interpret()}>
            {busy ? "Interpreting…" : "Interpret"}
          </button>
        </div>
        {error && <p className="error-banner">{error}</p>}
        {interpretation && (
          <div className="interpretation">
            {interpretation.notes.map((note) => (
              <p key={note} className="info-banner">
                {note}
              </p>
            ))}
            {interpretation.unmatched.length > 0 && (
              <div className="info-banner">
                <strong>We didn’t understand:</strong>
                <ul>
                  {interpretation.unmatched.map((u) => (
                    <li key={u}>“{u}”</li>
                  ))}
                </ul>
                Edit the fields below to cover anything missing.
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Interpreted fields — edit freely</h2>
        <label className="field">
          <span>Template</span>
          {workflows === null ? (
            <span className="muted">Loading…</span>
          ) : (
            <>
              {workflows.length > 0 && (
                <select value={fields.workflowSlug} onChange={(e) => flow.update({ workflowSlug: e.target.value })}>
                  {workflows.map((wf) => (
                    <option key={wf.slug} value={wf.slug}>
                      {wf.name}
                    </option>
                  ))}
                </select>
              )}
              {templates
                .filter((t) => !workflows.some((wf) => wf.slug === t.id))
                .map((t) => (
                  <button
                    key={t.id}
                    className="btn"
                    disabled={seeding !== null}
                    title={t.description}
                    onClick={() => onSeed(t.id)}
                  >
                    {seeding === t.id ? "Seeding…" : `Add “${t.name}”`}
                  </button>
                ))}
            </>
          )}
        </label>
        {sourceProvider === "imported-list" && (
          <label className="field">
            <span>Paste your list as CSV (max 500 rows)</span>
            <textarea
              className="request-box"
              rows={6}
              value={fields.importCsv}
              placeholder={"company,website,phone,email,linkedin,first_name,last_name,title,city,state\nAcme Roofing,acmeroofing.com,512-555-0100,…"}
              onChange={(e) => flow.update({ importCsv: e.target.value })}
            />
            <span className="muted">
              Recognized columns: company/name, website/domain, phone, email, linkedin, first/last/contact name, title,
              address, city, state, country. Rows without any identifier are rejected and listed in the preview.
            </span>
          </label>
        )}
        <label className="field">
          <span>Business category {evidence(flow, "businessType")}</span>
          <input
            value={fields.businessType}
            placeholder="e.g. roofing"
            onChange={(e) => flow.update({ businessType: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Locations (comma-separated) {evidence(flow, "locations")}</span>
          <input
            value={fields.locations.join(", ")}
            placeholder="e.g. Dallas, TX"
            onChange={(e) =>
              flow.update({
                locations: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
          />
        </label>
        <label className="field">
          <span>How many leads {evidence(flow, "limit")}</span>
          <input
            type="number"
            min={1}
            max={500}
            value={fields.limit}
            placeholder="workflow default"
            onChange={(e) => flow.update({ limit: e.target.value })}
          />
        </label>
        <div className="row row-end">
          <button className="btn btn-primary" disabled={!canContinue} onClick={onNext}>
            Continue to enrichment depth
          </button>
        </div>
      </section>
    </div>
  );
}

function evidence(flow: NewRunFlow, key: "businessType" | "locations" | "limit"): ReactElement | null {
  const suggestion = flow.interpretation?.suggestions[key];
  if (!suggestion) return null;
  return (
    <span className="chip chip-muted" title={`Matched: “${suggestion.evidence}”`}>
      from your request · {suggestion.confidence}
    </span>
  );
}

function applyInterpretation(flow: NewRunFlow, result: InterpretedRequest): void {
  const patch: Partial<NewRunFields> = {};
  const s = result.suggestions;
  if (s.businessType) patch.businessType = s.businessType.value;
  if (s.locations) patch.locations = s.locations.value;
  if (s.limit) patch.limit = String(s.limit.value);
  if (s.enrichmentProfile) patch.profile = s.enrichmentProfile.value;
  if (s.overrides) {
    const { findOwner, ...rest } = s.overrides.value;
    patch.overrides = { ...flow.fields.overrides, ...rest };
    if (findOwner !== undefined) patch.findOwner = findOwner;
  }
  flow.update(patch);
  flow.setInterpretation(result);
}
