import type { ReactElement } from "react";

import type { ProviderStatusInfo } from "../api/types.js";

const KIND_LABELS: Record<ProviderStatusInfo["kind"], string> = {
  source: "finds businesses",
  enrich: "finds people/contacts (paid)",
  research: "reads public websites",
  model: "writes summaries/openers",
};

export function ProviderStatusPanel({ providers }: { providers: ProviderStatusInfo[] }): ReactElement {
  return (
    <div className="provider-panel">
      {providers.map((p) => (
        <div key={p.name} className="provider-row">
          <span className={`chip ${p.connected ? "chip-ok" : "chip-warn"}`}>
            {p.connected ? "connected" : "missing"}
          </span>
          <strong>{p.name}</strong>
          <span className="muted">
            {KIND_LABELS[p.kind]}
            {p.name.startsWith("fake-") ? " — fake data, no real spend" : ""}
          </span>
        </div>
      ))}
      {providers.length === 0 && <p className="muted">No providers registered.</p>}
    </div>
  );
}
