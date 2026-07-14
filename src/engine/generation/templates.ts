import { z } from "zod";

import type { OutputKind } from "../../storage/database-types.js";
import type { GenerationKind, ModelPrompt } from "../../providers/models/types.js";
import type { EvidenceBundle } from "./evidence.js";
import { renderEvidence } from "./evidence.js";

/**
 * Code-owned, versioned generation templates (the SCORE_TEMPLATES pattern).
 * A workflow's generate step references a template by name; the version
 * string is written to generated_outputs.prompt_version and MUST be bumped on
 * any prompt or schema change. Output schemas avoid `.optional()` — vendor
 * strict modes require every property, so optional concepts are `.nullable()`.
 */
const claimSchema = z
  .object({
    text: z.string().min(1),
    /** Evidence ids (E1…) from the prompt's evidence list — grounding rule. */
    evidence: z.array(z.string()).min(1),
  })
  .strict();

export type GroundedClaim = z.infer<typeof claimSchema>;

const SHARED_SYSTEM_PREAMBLE = [
  "You write short, factual sales-research copy for a lead-generation tool.",
  "Use ONLY the numbered evidence items provided; never invent facts, numbers, names, or intent.",
  "Every claim object must cite the evidence ids it rests on.",
  "If the evidence does not support a statement, omit it — uncertain claims are omitted, not hedged.",
  "Reply with a single JSON object matching the requested schema and nothing else.",
].join(" ");

export const fitRationaleOutputSchema = z
  .object({
    summary: z.string().min(1),
    claims: z.array(claimSchema),
    caveats: z.array(z.string()),
  })
  .strict();
export type FitRationaleOutput = z.infer<typeof fitRationaleOutputSchema>;

export const callNotesOutputSchema = z
  .object({
    openerLine: z.string().min(1),
    talkingPoints: z.array(claimSchema).max(5),
    /** Only when a timezone evidence item exists; otherwise null (grounding enforces). */
    bestCallWindow: z.string().nullable(),
    doNotSay: z.array(z.string()),
  })
  .strict();
export type CallNotesOutput = z.infer<typeof callNotesOutputSchema>;

export const openerOutputSchema = z
  .object({
    subject: z.string().nullable(),
    opener: z.string().min(1),
    claims: z.array(claimSchema),
  })
  .strict();
export type OpenerOutput = z.infer<typeof openerOutputSchema>;

export interface GenerationTemplate {
  name: string;
  kind: GenerationKind;
  outputKind: OutputKind;
  promptVersion: string;
  outputSchema: z.ZodType<Record<string, unknown>>;
  /** Claim-bearing keys grounding walks; template is invalid if a REQUIRED one ends empty. */
  claimKeys: { key: "claims" | "talkingPoints"; required: boolean }[];
  /** Personalization templates are the ones skipPersonalization turns off. */
  isPersonalization: boolean;
  buildPrompt(bundle: EvidenceBundle): ModelPrompt;
}

function userPrompt(bundle: EvidenceBundle, instructions: string): string {
  return `EVIDENCE:\n${renderEvidence(bundle)}\n\nTASK:\n${instructions}`;
}

export const GENERATION_TEMPLATES: Map<string, GenerationTemplate> = new Map(
  (
    [
      {
        name: "fit-rationale",
        kind: "fit_rationale",
        outputKind: "fit_summary",
        promptVersion: "fit-rationale/v1",
        outputSchema: fitRationaleOutputSchema,
        claimKeys: [{ key: "claims", required: true }],
        isPersonalization: false,
        buildPrompt: (bundle) => ({
          system: SHARED_SYSTEM_PREAMBLE,
          user: userPrompt(
            bundle,
            "Explain in 2-3 sentences why this lead does or does not fit an outbound campaign, as `summary`. Add `claims`: each concrete supporting fact with its evidence ids. Add `caveats`: what is unknown or unverified (empty array if none). The deterministic fit score in the evidence is authoritative — you are explaining it, never overriding it.",
          ),
        }),
      },
      {
        name: "call-notes",
        kind: "call_notes",
        outputKind: "call_notes",
        promptVersion: "call-notes/v1",
        outputSchema: callNotesOutputSchema,
        claimKeys: [{ key: "talkingPoints", required: true }],
        isPersonalization: false,
        buildPrompt: (bundle) => ({
          system: SHARED_SYSTEM_PREAMBLE,
          user: userPrompt(
            bundle,
            "Prepare notes for a human cold caller. `openerLine`: one natural opening sentence for the call. `talkingPoints`: up to 5 short factual points, each citing evidence ids. `bestCallWindow`: a local-time suggestion ONLY if the evidence includes a timezone, else null. `doNotSay`: claims a caller must avoid because the evidence does not support them (e.g. never call a number 'verified' when only its format was checked).",
          ),
        }),
      },
      {
        name: "agency-opener",
        kind: "opener",
        outputKind: "opener",
        promptVersion: "opener/v1",
        outputSchema: openerOutputSchema,
        claimKeys: [{ key: "claims", required: true }],
        isPersonalization: true,
        buildPrompt: (bundle) => ({
          system: SHARED_SYSTEM_PREAMBLE,
          user: userPrompt(
            bundle,
            "Write a short personalized cold-email opener (1-2 sentences) as `opener`, and an optional subject line as `subject` (null if nothing natural). Ground every personalized statement in the evidence and list them in `claims` with their evidence ids. No pricing, no promises, no fabricated familiarity.",
          ),
        }),
      },
    ] as GenerationTemplate[]
  ).map((t) => [t.name, t]),
);
