import { z } from "zod";

/**
 * The typed deterministic operator allowlist for `filter` conditions and
 * `score` templates (json-rules-engine is deferred; see docs/decisions.md
 * ADR-003/ADR-004). Rules are serializable JSON over DECLARED typed fields:
 * no eval, no dynamic paths, no user-authored code.
 */
export const RULE_FIELDS = {
  name: "string",
  category: "string",
  locality: "string",
  region: "string",
  country: "string",
  has_website: "boolean",
  rating: "number",
  review_count: "number",
  phone_format_valid: "boolean",
  // M4 person/contact fields — deterministic from the persisted snapshot.
  title: "string",
  employer_name: "string",
  has_linkedin: "boolean",
  has_email: "boolean",
  // Stays false until a real deliverability check writes verified_email (M5);
  // an email a provider merely found NEVER sets it (contact-data honesty).
  has_verified_email: "boolean",
  has_direct_phone: "boolean",
} as const;

export type RuleField = keyof typeof RULE_FIELDS;
export type FieldContext = Partial<Record<RuleField, string | number | boolean | null>>;

export const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "exists"] as const;
export type Operator = (typeof OPERATORS)[number];

const fieldSchema = z.enum(Object.keys(RULE_FIELDS) as [RuleField, ...RuleField[]]);
const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const conditionSchema = z
  .object({
    field: fieldSchema,
    op: z.enum(OPERATORS),
    value: z.union([scalarSchema, z.array(scalarSchema)]).optional(),
  })
  .strict()
  .superRefine((cond, ctx) => {
    if (cond.op === "exists") {
      if (cond.value !== undefined) ctx.addIssue({ code: "custom", message: "'exists' takes no value" });
      return;
    }
    if (cond.op === "in" || cond.op === "not_in") {
      if (!Array.isArray(cond.value)) ctx.addIssue({ code: "custom", message: `'${cond.op}' requires an array value` });
      return;
    }
    if (cond.value === undefined || Array.isArray(cond.value)) {
      ctx.addIssue({ code: "custom", message: `'${cond.op}' requires a scalar value` });
      return;
    }
    if ((cond.op === "gt" || cond.op === "gte" || cond.op === "lt" || cond.op === "lte") && typeof cond.value !== "number") {
      ctx.addIssue({ code: "custom", message: `'${cond.op}' requires a numeric value` });
    }
    if (cond.op === "contains" && typeof cond.value !== "string") {
      ctx.addIssue({ code: "custom", message: "'contains' requires a string value" });
    }
  });

export type Condition = z.infer<typeof conditionSchema>;

/** One flat group: ALL conditions must hold, or ANY condition must hold. */
export const ruleGroupSchema = z.union([
  z.object({ all: z.array(conditionSchema).min(1).max(20) }).strict(),
  z.object({ any: z.array(conditionSchema).min(1).max(20) }).strict(),
]);

export type RuleGroup = z.infer<typeof ruleGroupSchema>;

export function evaluateCondition(cond: Condition, ctx: FieldContext): boolean {
  const actual = ctx[cond.field];
  switch (cond.op) {
    case "exists":
      return actual !== null && actual !== undefined && actual !== "";
    case "eq":
      return actual === cond.value;
    case "neq":
      return actual !== cond.value;
    case "gt":
      return typeof actual === "number" && actual > (cond.value as number);
    case "gte":
      return typeof actual === "number" && actual >= (cond.value as number);
    case "lt":
      return typeof actual === "number" && actual < (cond.value as number);
    case "lte":
      return typeof actual === "number" && actual <= (cond.value as number);
    case "in":
      return (cond.value as (string | number | boolean)[]).includes(actual as string | number | boolean);
    case "not_in":
      return !(cond.value as (string | number | boolean)[]).includes(actual as string | number | boolean);
    case "contains":
      return typeof actual === "string" && actual.toLowerCase().includes((cond.value as string).toLowerCase());
  }
}

export function evaluateRuleGroup(group: RuleGroup, ctx: FieldContext): boolean {
  if ("all" in group) return group.all.every((c) => evaluateCondition(c, ctx));
  return group.any.some((c) => evaluateCondition(c, ctx));
}
