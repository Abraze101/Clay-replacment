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
  APPROVAL_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MCP_HTTP_TOKEN: z.string().optional(),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MAX_STEP_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Background-job driver; long-lived entries default to pgboss, one-shot CLI to inprocess.
  JOB_DRIVER: z.enum(["inprocess", "pgboss"]).optional(),
  // Max seconds the in-process CLI driver will inline-wait to self-heal a rate-limit pause.
  RATE_LIMIT_INLINE_WAIT_MAX_SECONDS: z.coerce.number().int().min(0).max(900).default(120),
  // SerpAPI (M3 local-business discovery, ADR-024).
  SERPAPI_API_KEY: z.string().optional(),
  SERPAPI_BASE_URL: z.string().url().default("https://serpapi.com"),
  SERPAPI_MAX_RPM: z.coerce.number().int().min(1).max(240).default(10),
  SERPAPI_MAX_PAGES_PER_QUERY: z.coerce.number().int().min(1).max(10).default(6),
  SERPAPI_DEFAULT_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  // Firecrawl (M3 website research; ADR-023/027). Off unless explicitly selected.
  FIRECRAWL_API_KEY: z.string().optional(),
  FIRECRAWL_BASE_URL: z.string().url().default("https://api.firecrawl.dev"),
  WEBSITE_RESEARCH_PROVIDER: z.enum(["fake", "firecrawl"]).default("fake"),
  // Apollo (M4 professional workflows, ADR-014/ADR-028). A MASTER API key.
  APOLLO_API_KEY: z.string().optional(),
  APOLLO_BASE_URL: z.string().url().default("https://api.apollo.io"),
  // Free-tier Apollo allows 50 req/min; default well under it.
  APOLLO_MAX_RPM: z.coerce.number().int().min(1).max(240).default(30),
  // People search pages per query (100 hits/page; inputs.limit ≤ 500).
  APOLLO_MAX_PAGES_PER_QUERY: z.coerce.number().int().min(1).max(5).default(5),
  APOLLO_DEFAULT_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(86400).default(60),
  // Provider keys are optional (never used until their milestone; fake providers otherwise).
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
