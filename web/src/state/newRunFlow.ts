import { useCallback, useState } from "react";

import type { CapabilityOverrides, InterpretedRequest, PreviewResult, Profile } from "../api/types.js";

/**
 * Wizard state for a new lead list. The approval token lives only inside
 * `preview` in React memory — never localStorage — and any edit to any field
 * discards it (the engine's plan hash re-check enforces this server-side too).
 */
export interface NewRunFields {
  workflowSlug: string;
  businessType: string;
  locations: string[];
  /** Empty string = use the workflow's own default limit. */
  limit: string;
  profile: Profile;
  /** Default on: unchecking sends findOwner=false to disable the optional owner-enrich step. */
  findOwner: boolean;
  overrides: Omit<CapabilityOverrides, "findOwner">;
  /** Empty string = engine default (hard cap 100). */
  cap: string;
  /** Empty string = estimated cost. */
  budget: string;
}

export interface RunRequestOptions {
  inputs?: Record<string, unknown>;
  profile: Profile;
  overrides?: CapabilityOverrides;
  cap?: number;
  budget?: number;
}

export const INITIAL_FIELDS: NewRunFields = {
  workflowSlug: "",
  businessType: "",
  locations: [],
  limit: "",
  profile: "quick_list",
  findOwner: true,
  overrides: {},
  cap: "",
  budget: "",
};

/** Compile the editable fields into the exact options object sent to preview AND start. */
export function toRunOptions(fields: NewRunFields): RunRequestOptions {
  const inputs: Record<string, unknown> = {};
  if (fields.businessType.trim().length > 0) inputs.businessType = fields.businessType.trim();
  if (fields.locations.length > 0) inputs.locations = fields.locations;
  const limit = Number(fields.limit);
  if (fields.limit.trim().length > 0 && Number.isInteger(limit) && limit > 0) inputs.limit = limit;

  const overrides: CapabilityOverrides = { ...fields.overrides };
  if (!fields.findOwner) overrides.findOwner = false;

  const cap = Number(fields.cap);
  const budget = Number(fields.budget);
  return {
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    profile: fields.profile,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(fields.cap.trim().length > 0 && Number.isInteger(cap) ? { cap } : {}),
    ...(fields.budget.trim().length > 0 && Number.isFinite(budget) ? { budget } : {}),
  };
}

export interface NewRunFlow {
  fields: NewRunFields;
  interpretation: InterpretedRequest | null;
  preview: PreviewResult | null;
  /** The exact options the preview was issued for; start must send the same object. */
  previewOptions: RunRequestOptions | null;
  update(patch: Partial<NewRunFields>): void;
  setInterpretation(result: InterpretedRequest): void;
  setPreview(preview: PreviewResult, options: RunRequestOptions): void;
  clearPreview(): void;
}

export function useNewRunFlow(): NewRunFlow {
  const [fields, setFields] = useState<NewRunFields>(INITIAL_FIELDS);
  const [interpretation, setInterpretationState] = useState<InterpretedRequest | null>(null);
  const [preview, setPreviewState] = useState<PreviewResult | null>(null);
  const [previewOptions, setPreviewOptions] = useState<RunRequestOptions | null>(null);

  const update = useCallback((patch: Partial<NewRunFields>) => {
    setFields((prev) => ({ ...prev, ...patch }));
    // Any edit invalidates the held approval token.
    setPreviewState(null);
    setPreviewOptions(null);
  }, []);

  const setInterpretation = useCallback((result: InterpretedRequest) => {
    setInterpretationState(result);
  }, []);

  const setPreview = useCallback((p: PreviewResult, options: RunRequestOptions) => {
    setPreviewState(p);
    setPreviewOptions(options);
  }, []);

  const clearPreview = useCallback(() => {
    setPreviewState(null);
    setPreviewOptions(null);
  }, []);

  return { fields, interpretation, preview, previewOptions, update, setInterpretation, setPreview, clearPreview };
}
