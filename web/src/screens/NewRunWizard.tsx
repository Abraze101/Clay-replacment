import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { apiGet, apiPost, errorMessage } from "../api/client.js";
import type { PreviewResult, TemplateSummary, WorkflowCreateResponse, WorkflowSummary } from "../api/types.js";
import { navigate } from "../router.js";
import { toRunOptions, useNewRunFlow } from "../state/newRunFlow.js";
import { GuidedRequestScreen } from "./GuidedRequestScreen.js";
import { PresetScreen } from "./PresetScreen.js";
import { PreviewScreen } from "./PreviewScreen.js";

/**
 * The three-step new-lead-list wizard: guided request → preset → preview/approve.
 * With `continueFrom`, the wizard seeds the call-ready-continuation template,
 * binds the prior run's APPROVED leads (no re-sourcing), and starts at the
 * enrichment-depth step — the preview/approval path is identical.
 */
export function NewRunWizard({ continueFrom }: { continueFrom?: string } = {}): ReactElement {
  const flow = useNewRunFlow();
  const [step, setStep] = useState<1 | 2 | 3>(continueFrom ? 2 : 1);
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [seeding, setSeeding] = useState<string | null>(null);
  const [sourceProvider, setSourceProvider] = useState<string>("");
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadWorkflows = useCallback(async (): Promise<WorkflowSummary[]> => {
    const res = await apiGet<{ workflows: WorkflowSummary[] }>("/api/workflows");
    setWorkflows(res.data.workflows);
    return res.data.workflows;
  }, []);

  useEffect(() => {
    if (continueFrom) {
      // Continuation: seed the built-in continuation workflow (idempotent) and
      // bind the prior run; the engine resolves its approved rows at preview.
      void apiPost<WorkflowCreateResponse>("/api/workflows", { template: "call-ready-continuation" })
        .then(async (created) => {
          await loadWorkflows();
          flow.update({ workflowSlug: created.data.slug, continueFromRunId: continueFrom, profile: "call_ready" });
        })
        .catch(() => undefined);
    } else {
      void loadWorkflows().then((list) => {
        const first = list[0];
        if (first) flow.update({ workflowSlug: first.slug });
      });
    }
    void apiGet<{ templates: TemplateSummary[] }>("/api/templates").then((res) => setTemplates(res.data.templates));
    // Load once on mount; flow.update identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadWorkflows, continueFrom]);

  // The selected workflow's SOURCE decides which extra inputs make sense
  // (imported-list needs pasted CSV). Derived from the stored definition, so
  // it works for template-seeded and custom workflows alike.
  useEffect(() => {
    const slug = flow.fields.workflowSlug;
    if (!slug) {
      setSourceProvider("");
      return;
    }
    let cancelled = false;
    void apiGet<{ definition: { steps?: { type: string; provider?: string }[] } }>(`/api/workflows/${slug}`)
      .then((res) => {
        if (cancelled) return;
        const source = res.data.definition.steps?.find((s) => s.type === "source");
        setSourceProvider(source?.provider ?? "");
      })
      .catch(() => setSourceProvider(""));
    return () => {
      cancelled = true;
    };
  }, [flow.fields.workflowSlug]);

  const seed = async (templateId: string): Promise<void> => {
    setSeeding(templateId);
    try {
      const created = await apiPost<WorkflowCreateResponse>("/api/workflows", { template: templateId });
      await loadWorkflows();
      flow.update({ workflowSlug: created.data.slug });
    } finally {
      setSeeding(null);
    }
  };

  const preview = async (): Promise<void> => {
    setPreviewing(true);
    setPreviewError(null);
    const options = toRunOptions(flow.fields);
    try {
      const res = await apiPost<PreviewResult>(`/api/workflows/${flow.fields.workflowSlug}/preview`, options);
      flow.setPreview(res.data, options);
      setStep(3);
    } catch (err) {
      setPreviewError(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>{continueFrom ? "Continue approved leads" : "New lead list"}</h1>
        <button className="btn" onClick={() => navigate("/")}>
          Home
        </button>
      </div>
      {continueFrom && (
        <p className="info-banner">
          Continuing the APPROVED leads of run {continueFrom} into deeper enrichment — no re-sourcing, and the selection
          is bound into your approval (a review change there requires a fresh preview).
        </p>
      )}
      <ol className="steps-nav">
        <li className={step === 1 ? "active" : ""}>Describe</li>
        <li className={step === 2 ? "active" : ""}>Enrichment depth</li>
        <li className={step === 3 ? "active" : ""}>Preview & approve</li>
      </ol>
      {step === 1 && (
        <GuidedRequestScreen
          flow={flow}
          workflows={workflows}
          templates={templates}
          seeding={seeding}
          sourceProvider={sourceProvider}
          onSeed={(id) => void seed(id)}
          onNext={() => setStep(2)}
        />
      )}
      {step === 2 && (
        <PresetScreen
          flow={flow}
          onBack={() => setStep(1)}
          onPreview={() => void preview()}
          previewing={previewing}
          error={previewError}
        />
      )}
      {step === 3 && (
        <PreviewScreen
          flow={flow}
          onBack={() => {
            flow.clearPreview();
            setStep(2);
          }}
        />
      )}
    </div>
  );
}
