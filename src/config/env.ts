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
  // ── M5 contact-enrichment capability selection (ADR-031). Each capability
  // binds to the fake provider by default; a live vendor activates only when
  // BOTH the selection var and its key(s) are present (doubly opt-in, the
  // WEBSITE_RESEARCH_PROVIDER pattern). Selection without a key leaves the
  // capability unregistered so workflow validation fails loudly.
  PHONE_VALIDATION_PROVIDER: z.enum(["fake", "twilio"]).default("fake"),
  EMAIL_VERIFICATION_PROVIDER: z.enum(["fake", "zerobounce", "millionverifier"]).default("fake"),
  CONTACT_DISCOVERY_PROVIDER: z.enum(["fake", "bettercontact", "fullenrich", "leadmagic"]).default("fake"),
  FAKE_CAPABILITY_LEDGER_PATH: z.string().min(1).default("./.data/fake-capability-ledger.json"),
  // Twilio Lookup v2 (ADR-009 first phone-validation candidate; ADR-030).
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_LOOKUP_BASE_URL: z.string().url().default("https://lookups.twilio.com"),
  TWILIO_MAX_RPM: z.coerce.number().int().min(1).max(240).default(60),
  TWILIO_DEFAULT_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  // Identity Match is an approval-gated Twilio package; off unless enabled.
  TWILIO_IDENTITY_MATCH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // ZeroBounce (ADR-010 email-verification candidate).
  ZEROBOUNCE_API_KEY: z.string().optional(),
  ZEROBOUNCE_BASE_URL: z.string().url().default("https://api.zerobounce.net"),
  ZEROBOUNCE_MAX_RPM: z.coerce.number().int().min(1).max(240).default(60),
  ZEROBOUNCE_DEFAULT_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  // MillionVerifier (ADR-010 email-verification candidate). The vendor-side
  // timeout is set BELOW our 30s client timeout so a slow SMTP check returns a
  // definitive uncharged 'unknown' instead of an ambiguous socket timeout.
  MILLIONVERIFIER_API_KEY: z.string().optional(),
  MILLIONVERIFIER_BASE_URL: z.string().url().default("https://api.millionverifier.com"),
  MILLIONVERIFIER_MAX_RPM: z.coerce.number().int().min(1).max(240).default(60),
  MILLIONVERIFIER_DEFAULT_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  MILLIONVERIFIER_VENDOR_TIMEOUT_SECONDS: z.coerce.number().int().min(2).max(25).default(20),
  // BetterContact (ADR-008 discovery candidate; async submit-then-poll, ADR-029).
  BETTERCONTACT_API_KEY: z.string().optional(),
  BETTERCONTACT_BASE_URL: z.string().url().default("https://app.bettercontact.rocks"),
  BETTERCONTACT_MAX_RPM: z.coerce.number().int().min(1).max(240).default(30),
  BETTERCONTACT_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(600).default(10),
  BETTERCONTACT_DEFAULT_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  // FullEnrich (ADR-008 discovery candidate; async submit-then-poll, ADR-029).
  FULLENRICH_API_KEY: z.string().optional(),
  FULLENRICH_BASE_URL: z.string().url().default("https://app.fullenrich.com"),
  FULLENRICH_MAX_RPM: z.coerce.number().int().min(1).max(240).default(30),
  FULLENRICH_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(600).default(15),
  FULLENRICH_DEFAULT_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  // LeadMagic (ADR-008 discovery candidate; sync, no job id — the ambiguous-on-timeout case).
  LEADMAGIC_API_KEY: z.string().optional(),
  LEADMAGIC_BASE_URL: z.string().url().default("https://api.leadmagic.io"),
  LEADMAGIC_MAX_RPM: z.coerce.number().int().min(1).max(240).default(30),
  LEADMAGIC_DEFAULT_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  // ── M5 model providers (one shared generation interface; ADR-012/ADR-032).
  // 'fake' registers the deterministic fake model; unset with multiple keys
  // present prefers openrouter > minimax > openai > anthropic (OpenRouter is
  // the owner's chosen MiniMax route). Generation is optional: every workflow
  // still runs with no model provider configured.
  GENERATE_MODEL_PROVIDER: z.enum(["openrouter", "minimax", "openai", "anthropic", "fake"]).optional(),
  // OpenRouter (owner decision 2026-07-13): MiniMax M3 via OpenRouter's
  // OpenAI-compatible chat-completions API — no direct MiniMax account.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL: z.string().min(1).default("minimax/minimax-m3"),
  MINIMAX_API_KEY: z.string().optional(),
  MINIMAX_BASE_URL: z.string().url().default("https://api.minimax.io"),
  MINIMAX_MODEL: z.string().min(1).default("MiniMax-M3"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com"),
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
  ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com"),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-haiku-4-5"),
  // Structured generation outputs stay small (bounded-JSON step results).
  GENERATE_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(4000).default(800),
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
