import type { EvidenceRef, JsonObject } from "../../storage/database-types.js";
import type { EvidenceBundle } from "./evidence.js";
import type { GenerationTemplate, GroundedClaim } from "./templates.js";

/**
 * Engine-side grounding enforcement (identical across vendors): claims citing
 * evidence ids that are not in the bundle are STRIPPED; a required
 * claim-bearing section that ends empty invalidates the output (feeding the
 * retry-once-then-continue rule); `bestCallWindow` is nulled unless timezone
 * evidence exists. Returns the cleaned content plus the resolved EvidenceRef
 * list for generated_outputs.evidence.
 */
export type GroundingResult =
  | { ok: true; content: JsonObject; evidence: EvidenceRef[]; strippedClaims: number }
  | { ok: false; reason: string };

export function validateGrounding(
  raw: Record<string, unknown>,
  template: GenerationTemplate,
  bundle: EvidenceBundle,
): GroundingResult {
  const content: Record<string, unknown> = { ...raw };
  const evidence: EvidenceRef[] = [];
  const seenRefs = new Set<string>();
  let strippedClaims = 0;

  for (const { key, required } of template.claimKeys) {
    const claims = (content[key] ?? []) as GroundedClaim[];
    const kept: GroundedClaim[] = [];
    for (const claim of claims) {
      const ids = claim.evidence.filter((id) => bundle.byId.has(id));
      if (ids.length === 0) {
        strippedClaims += 1;
        continue; // a claim with no verifiable grounding never survives
      }
      kept.push({ ...claim, evidence: ids });
      for (const id of ids) {
        const item = bundle.byId.get(id);
        if (!item) continue;
        const refKey = JSON.stringify(item.ref);
        if (!seenRefs.has(refKey)) {
          seenRefs.add(refKey);
          evidence.push(item.ref);
        }
      }
    }
    content[key] = kept;
    if (required && kept.length === 0) {
      return { ok: false, reason: `no grounded ${key} survived evidence validation` };
    }
  }

  // A call window without timezone evidence is a fabrication — null it.
  if ("bestCallWindow" in content && content["bestCallWindow"] !== null && !bundle.hasTimezone) {
    content["bestCallWindow"] = null;
  }

  return { ok: true, content: content, evidence, strippedClaims };
}
