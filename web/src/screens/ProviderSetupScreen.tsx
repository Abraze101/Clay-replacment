import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { apiGet, apiPost, errorMessage } from "../api/client.js";
import type { ProviderStatusInfo, ProviderTestResult } from "../api/types.js";
import { navigate } from "../router.js";

/**
 * Provider setup (ui-scope §4, minimal M3 form): explains what each live
 * provider supplies, where its API key goes (the server environment — keys are
 * never entered in or sent to the browser), and offers a zero-cost connection
 * test. Fake providers are omitted here; they appear on Home.
 */
export function ProviderSetupScreen(): ReactElement {
  const [providers, setProviders] = useState<ProviderStatusInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { busy: boolean; result?: ProviderTestResult; error?: string }>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<{ providers: ProviderStatusInfo[] }>("/api/providers");
      setProviders(res.data.providers.filter((p) => p.requiresEnv !== undefined));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runTest = async (name: string): Promise<void> => {
    setTests((prev) => ({ ...prev, [name]: { busy: true } }));
    try {
      const res = await apiPost<ProviderTestResult>(`/api/providers/${encodeURIComponent(name)}/test`, {});
      setTests((prev) => ({ ...prev, [name]: { busy: false, result: res.data } }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [name]: { busy: false, error: errorMessage(err) } }));
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>Provider setup</h1>
        <button className="btn" onClick={() => navigate("/")}>
          Home
        </button>
      </div>
      {error && <p className="error-banner">{error}</p>}

      <section className="card">
        <p className="muted">
          API keys stay in the server&apos;s environment (for example a local <code>.env</code> file) and are never
          entered here or shown after entry. After adding or changing a key, restart the server and re-test.
        </p>
        {providers === null ? (
          <p className="muted">Loading…</p>
        ) : providers.length === 0 ? (
          <p className="muted">No live providers are known to this build.</p>
        ) : (
          providers.map((p) => {
            const t = tests[p.name];
            return (
              <div key={p.name} className="card">
                <div className="row">
                  <span className={`chip ${p.connected ? "chip-ok" : "chip-warn"}`}>
                    {p.connected ? "connected" : "missing"}
                  </span>
                  <strong>{p.name}</strong>
                  {p.paid && <span className="chip chip-warn">paid</span>}
                </div>
                {p.description && <p>{p.description}</p>}
                <p className="muted">
                  Connects via <code>{p.requiresEnv}</code> in the server environment.
                  {p.name === "local-business" &&
                    " Likely charges: one SerpAPI search per location per run (the preview shows the exact count before approval)."}
                  {p.name === "website-research" &&
                    " Likely charges: one Firecrawl credit per researched website (only for call-ready/full runs, only for approved rows)."}
                </p>
                <div className="row">
                  <button
                    className="btn btn-small"
                    disabled={!p.connected || t?.busy === true}
                    onClick={() => void runTest(p.name)}
                  >
                    {t?.busy ? "Testing…" : "Test connection (free)"}
                  </button>
                  {t?.result && (
                    <span className={`chip ${t.result.ok ? "chip-ok" : "chip-warn"}`}>{t.result.detail}</span>
                  )}
                  {t?.error && <span className="chip chip-warn">failed: {t.error}</span>}
                </div>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
