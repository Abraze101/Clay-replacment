import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// dotenv 17 prints a stdout banner by default, which would corrupt `--json`
// CLI output; `quiet` suppresses it (scaffolding audit defect #5).
loadDotenv({ quiet: true });

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(/^(pglite|postgresql|postgres):\/\/.+/, "DATABASE_URL must be pglite:// or postgresql://")
    .default("pglite://./.data/lead-engine"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  EXPORT_DIR: z.string().min(1).default("./exports"),
  FAKE_ENRICH_LEDGER_PATH: z.string().min(1).default("./.data/fake-enrich-ledger.json"),
  LEASE_TTL_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  MAX_STEP_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Provider keys are optional in M0 (never used; fake providers only).
  APOLLO_API_KEY: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}

export const env: Env = parseEnv();
