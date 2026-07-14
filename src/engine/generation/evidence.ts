import { iso } from "../../shared/clock.js";
import { num } from "../../storage/database-types.js";
import type { EvidenceRef } from "../../storage/database-types.js";
import type { ContactPointRow, LeadRow } from "../../storage/repositories/lead-repo.js";
import type { RunItemRow } from "../../storage/repositories/run-repo.js";
import type { ItemSnapshot } from "../runner/executors.js";

/**
 * The typed evidence bundle a model prompt is built from — PERSISTED source
 * fields only, each carrying the EvidenceRef written to generated_outputs
 * when a claim cites it. The model never sees anything that is not in here,
 * and grounding validation strips any claim citing an id that is not.
 */
export interface EvidenceItem {
  /** Stable citation id (E1, E2, …) the model must reference. */
  id: string;
  label: string;
  value: string;
  ref: EvidenceRef;
}

export interface EvidenceBundle {
  items: EvidenceItem[];
  byId: Map<string, EvidenceItem>;
  /** True when a timezone evidence item exists (gates bestCallWindow claims). */
  hasTimezone: boolean;
}

export function buildEvidenceBundle(args: {
  item: RunItemRow;
  lead: LeadRow;
  contactPoints: ContactPointRow[];
}): EvidenceBundle {
  const { item, lead, contactPoints } = args;
  const snapshot = item.snapshot as unknown as ItemSnapshot;
  const items: EvidenceItem[] = [];
  const sourceRef = (field: string): EvidenceRef =>
    snapshot.sourceLeadSourceId ? { leadSourceId: snapshot.sourceLeadSourceId, field } : { field };

  const push = (label: string, value: string | number | null | undefined, ref: EvidenceRef): void => {
    if (value === null || value === undefined || value === "") return;
    items.push({ id: `E${items.length + 1}`, label, value: String(value), ref });
  };

  const n = snapshot.normalized;
  push("business or person name", lead.display_name, sourceRef("displayName"));
  push("category", lead.category, sourceRef("category"));
  push("location", [lead.locality, lead.region].filter(Boolean).join(", "), sourceRef("locality"));
  push("website", lead.website_url, sourceRef("websiteUrl"));
  push("rating", n?.rating ?? null, sourceRef("rating"));
  push("review count", n?.reviewCount ?? null, sourceRef("reviewCount"));
  push("timezone", lead.timezone, sourceRef("timezone"));
  if (snapshot.enrichment) {
    push("contact name", snapshot.enrichment.personName, sourceRef("enrichment.personName"));
    push("contact title", snapshot.enrichment.title, sourceRef("enrichment.title"));
  }
  if (snapshot.research?.summary) {
    push(
      "website research summary",
      snapshot.research.summary,
      snapshot.research.leadSourceId ? { leadSourceId: snapshot.research.leadSourceId, field: "summary" } : { field: "research.summary" },
    );
  }
  push("fit score", item.score === null ? null : num(item.score), { field: "run_items.score" });
  if (item.call_readiness_status) {
    push("call readiness", `${item.call_readiness_status} (${item.call_readiness_reason ?? ""})`, {
      field: "run_items.call_readiness_status",
    });
  }
  for (const cp of contactPoints) {
    if (cp.type === "phone" && cp.normalized_value) {
      const signals: string[] = [];
      if (cp.line_type) signals.push(`line type ${cp.line_type}`);
      if (cp.line_status) signals.push(`line status ${cp.line_status} (checked ${iso(cp.line_status_checked_at) ?? "?"})`);
      if (cp.format_valid !== null && signals.length === 0) signals.push(cp.format_valid ? "format valid" : "format invalid");
      push(`${cp.role} phone`, `${cp.normalized_value}${signals.length ? ` — ${signals.join(", ")}` : ""}`, {
        contactPointId: cp.id,
        field: "normalized_value",
      });
    }
    if (cp.type === "email" && cp.normalized_value) {
      push(`${cp.role} email`, `${cp.normalized_value} — status ${cp.email_status ?? "not_checked"}`, {
        contactPointId: cp.id,
        field: "normalized_value",
      });
    }
  }

  return {
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    hasTimezone: items.some((i) => i.label === "timezone"),
  };
}

/** Render the bundle as the model-facing evidence list. */
export function renderEvidence(bundle: EvidenceBundle): string {
  return bundle.items.map((i) => `${i.id}: ${i.label} = ${i.value}`).join("\n");
}
