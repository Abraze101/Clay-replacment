import { z } from "zod";

/**
 * Typed per-capability overrides (directive §7). All keys are validated and
 * bound into the plan hash. Since M5 the contact-capability keys actually
 * gate their steps: `find*`/`validate*` force-include or exclude the matching
 * capability step, while the policy keys parameterize the acceptance rule and
 * call-readiness policy instead of toggling steps.
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

/** Contact-capability step values an enrich step may declare (M5). */
export const CONTACT_CAPABILITIES = [
  "phone_discovery",
  "phone_validation",
  "email_discovery",
  "email_verification",
] as const;
export type ContactCapabilityName = (typeof CONTACT_CAPABILITIES)[number];

/** Override key → the capability step it force-includes (true) or excludes (false). */
export const CAPABILITY_OVERRIDES = {
  findPhones: "phone_discovery",
  validatePhones: "phone_validation",
  findEmail: "email_discovery",
  validateEmail: "email_verification",
} as const satisfies Partial<Record<keyof CapabilityOverrides, ContactCapabilityName>>;

/**
 * Overrides that parameterize the acceptance rule / call-readiness policy
 * rather than toggling a step: requireDirectPhone narrows acceptable phone
 * roles to direct/mobile (and forces acceptBusinessMainPhone off);
 * acceptCatchAllEmail lets a catch_all verification satisfy the email
 * acceptance rule (it still NEVER sets verified_email).
 */
export const POLICY_OVERRIDES = ["requireDirectPhone", "acceptBusinessMainPhone", "acceptCatchAllEmail"] as const;
