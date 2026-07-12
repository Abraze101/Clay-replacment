import { z } from "zod";

/**
 * Typed per-capability overrides (directive §7). All keys are validated and
 * bound into the plan hash; capabilities without an M0 step effect are
 * surfaced as plan warnings rather than silently accepted behavior.
 */
export const overridesSchema = z
  .object({
    acceptBusinessMainPhone: z.boolean().optional(),
    requireDirectPhone: z.boolean().optional(),
    findOwner: z.boolean().optional(),
    findPhones: z.boolean().optional(),
    validatePhones: z.boolean().optional(),
    findEmail: z.boolean().optional(),
    validateEmail: z.boolean().optional(),
    acceptCatchAllEmail: z.boolean().optional(),
    skipPersonalization: z.boolean().optional(),
  })
  .strict();

export type CapabilityOverrides = z.infer<typeof overridesSchema>;

/** Overrides whose step-level effect only exists from M5 (contact enrichment). */
export const M5_ONLY_OVERRIDES: (keyof CapabilityOverrides)[] = [
  "acceptBusinessMainPhone",
  "requireDirectPhone",
  "findPhones",
  "validatePhones",
  "findEmail",
  "validateEmail",
  "acceptCatchAllEmail",
];
