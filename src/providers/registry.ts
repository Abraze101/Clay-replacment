import type { Kysely } from "kysely";

import type { Env } from "../config/env.js";
import type { Database } from "../storage/database-types.js";
import { ApolloClient } from "./apollo/client.js";
import { RunContinuationSource } from "./continuation/source.js";
import { ApolloEnrichProvider } from "./apollo/enrich.js";
import { ApolloPeopleSource } from "./apollo/people-source.js";
import { FakeContactDiscovery } from "./fake/contact-discovery.js";
import { FakeEmailVerification } from "./fake/email-verification.js";
import { FakeEnrichProvider } from "./fake/enrich.js";
import { FakeModelProvider } from "./fake/model.js";
import { FakePhoneValidation } from "./fake/phone-validation.js";
import { FakeResearchProvider } from "./fake/research.js";
import { FakeSourceProvider } from "./fake/source.js";
import { AnthropicModelProvider } from "./models/anthropic.js";
import { MiniMaxModelProvider } from "./models/minimax.js";
import { OpenAiModelProvider } from "./models/openai.js";
import { OpenRouterModelProvider } from "./models/openrouter.js";
import { FirecrawlClient } from "./firecrawl/client.js";
import { FirecrawlWebsiteResearch } from "./firecrawl/website-research.js";
import { ImportedListSource } from "./imported/source.js";
import { SerpApiClient } from "./serpapi/client.js";
import { SerpApiLocalBusinessSource } from "./serpapi/maps-source.js";
import { BetterContactDiscovery } from "./bettercontact/contact-discovery.js";
import { FullEnrichDiscovery } from "./fullenrich/contact-discovery.js";
import { LeadMagicDiscovery } from "./leadmagic/contact-discovery.js";
import { MillionVerifierEmailVerification } from "./millionverifier/email-verification.js";
import { TwilioPhoneValidation } from "./twilio/phone-validation.js";
import { ZeroBounceEmailVerification } from "./zerobounce/email-verification.js";
import type { ProviderRegistry } from "./types.js";
import { emptyRegistry } from "./types.js";

export interface RegistryOptions {
  enrichLedgerPath: string;
  /** Shared ledger for the three fake capability providers; defaults next to the enrich ledger. */
  capabilityLedgerPath?: string;
  /**
   * Database handle for DB-backed providers (the free run-continuation
   * source). When absent (bare test registries), continuation is unregistered.
   */
  db?: Kysely<Database>;
}

/**
 * The always-present fake providers (demo workflows + offline tests) and an
 * intentionally EMPTY model-provider map. Real adapters are layered on top by
 * buildRegistry when their credentials are configured.
 */
export function buildFakeRegistry(options: RegistryOptions): ProviderRegistry {
  const registry = emptyRegistry();
  const source = new FakeSourceProvider();
  const enrich = new FakeEnrichProvider(options.enrichLedgerPath);
  const research = new FakeResearchProvider();
  registry.sources.set(source.name, source);
  registry.enrichers.set(enrich.name, enrich);
  registry.researchers.set(research.name, research);
  // The imported-list source is free and credential-less: always present so a
  // CSV import works offline in every install (M4).
  const imported = new ImportedListSource();
  registry.sources.set(imported.name, imported);
  // Selected-lead continuation (M5): free, credential-less, DB-backed.
  if (options.db) {
    const continuation = new RunContinuationSource(options.db);
    registry.sources.set(continuation.name, continuation);
  }
  // M5 contact-capability fakes: always present so Call-Ready flows run
  // offline; buildRegistry swaps them out when a live vendor is selected.
  const capabilityLedger = options.capabilityLedgerPath ?? "./.data/fake-capability-ledger.json";
  const phoneValidation = new FakePhoneValidation(capabilityLedger);
  const emailVerification = new FakeEmailVerification(capabilityLedger);
  const contactDiscovery = new FakeContactDiscovery(capabilityLedger);
  registry.phoneValidation.set(phoneValidation.name, phoneValidation);
  registry.emailVerification.set(emailVerification.name, emailVerification);
  registry.contactDiscovery.set(contactDiscovery.name, contactDiscovery);
  return registry;
}

/**
 * The runtime registry: the fakes plus any configured live adapters. The live
 * local-business source (SerpAPI, ADR-024) registers under the provider-neutral
 * name "local-business" only when SERPAPI_API_KEY is set; a workflow that
 * references it without the key fails validation with a clear message.
 */
export function buildRegistry(env: Env, options: RegistryOptions): ProviderRegistry {
  const registry = buildFakeRegistry(options);

  // M5 capability selection (ADR-031): a non-fake selection REMOVES the fake
  // from that capability. When the vendor's key is present the live adapter
  // registers below (ADR-030); selection WITHOUT a key leaves the capability
  // empty so workflow validation fails loudly instead of silently using a fake.
  // Adapter built ≠ vendor selected: run the ADR-008/009/010 benchmarks first.
  if (env.PHONE_VALIDATION_PROVIDER !== "fake") {
    registry.phoneValidation.clear();
    if (env.PHONE_VALIDATION_PROVIDER === "twilio" && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
      const twilio = new TwilioPhoneValidation({
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        baseUrl: env.TWILIO_LOOKUP_BASE_URL,
        maxRequestsPerMinute: env.TWILIO_MAX_RPM,
        defaultRetryAfterSeconds: env.TWILIO_DEFAULT_RETRY_AFTER_SECONDS,
        identityMatchEnabled: env.TWILIO_IDENTITY_MATCH_ENABLED,
      });
      registry.phoneValidation.set(twilio.name, twilio);
    }
  }
  if (env.EMAIL_VERIFICATION_PROVIDER !== "fake") {
    registry.emailVerification.clear();
    if (env.EMAIL_VERIFICATION_PROVIDER === "zerobounce" && env.ZEROBOUNCE_API_KEY) {
      const zerobounce = new ZeroBounceEmailVerification({
        apiKey: env.ZEROBOUNCE_API_KEY,
        baseUrl: env.ZEROBOUNCE_BASE_URL,
        maxRequestsPerMinute: env.ZEROBOUNCE_MAX_RPM,
        defaultRetryAfterSeconds: env.ZEROBOUNCE_DEFAULT_RETRY_AFTER_SECONDS,
      });
      registry.emailVerification.set(zerobounce.name, zerobounce);
    }
    if (env.EMAIL_VERIFICATION_PROVIDER === "millionverifier" && env.MILLIONVERIFIER_API_KEY) {
      const millionverifier = new MillionVerifierEmailVerification({
        apiKey: env.MILLIONVERIFIER_API_KEY,
        baseUrl: env.MILLIONVERIFIER_BASE_URL,
        maxRequestsPerMinute: env.MILLIONVERIFIER_MAX_RPM,
        defaultRetryAfterSeconds: env.MILLIONVERIFIER_DEFAULT_RETRY_AFTER_SECONDS,
        vendorTimeoutSeconds: env.MILLIONVERIFIER_VENDOR_TIMEOUT_SECONDS,
      });
      registry.emailVerification.set(millionverifier.name, millionverifier);
    }
  }
  if (env.CONTACT_DISCOVERY_PROVIDER !== "fake") {
    registry.contactDiscovery.clear();
    if (env.CONTACT_DISCOVERY_PROVIDER === "bettercontact" && env.BETTERCONTACT_API_KEY) {
      const bettercontact = new BetterContactDiscovery({
        apiKey: env.BETTERCONTACT_API_KEY,
        baseUrl: env.BETTERCONTACT_BASE_URL,
        maxRequestsPerMinute: env.BETTERCONTACT_MAX_RPM,
        defaultRetryAfterSeconds: env.BETTERCONTACT_DEFAULT_RETRY_AFTER_SECONDS,
        pollIntervalSeconds: env.BETTERCONTACT_POLL_INTERVAL_SECONDS,
      });
      registry.contactDiscovery.set(bettercontact.name, bettercontact);
    }
    if (env.CONTACT_DISCOVERY_PROVIDER === "fullenrich" && env.FULLENRICH_API_KEY) {
      const fullenrich = new FullEnrichDiscovery({
        apiKey: env.FULLENRICH_API_KEY,
        baseUrl: env.FULLENRICH_BASE_URL,
        maxRequestsPerMinute: env.FULLENRICH_MAX_RPM,
        defaultRetryAfterSeconds: env.FULLENRICH_DEFAULT_RETRY_AFTER_SECONDS,
        pollIntervalSeconds: env.FULLENRICH_POLL_INTERVAL_SECONDS,
      });
      registry.contactDiscovery.set(fullenrich.name, fullenrich);
    }
    if (env.CONTACT_DISCOVERY_PROVIDER === "leadmagic" && env.LEADMAGIC_API_KEY) {
      const leadmagic = new LeadMagicDiscovery({
        apiKey: env.LEADMAGIC_API_KEY,
        baseUrl: env.LEADMAGIC_BASE_URL,
        maxRequestsPerMinute: env.LEADMAGIC_MAX_RPM,
        defaultRetryAfterSeconds: env.LEADMAGIC_DEFAULT_RETRY_AFTER_SECONDS,
      });
      registry.contactDiscovery.set(leadmagic.name, leadmagic);
    }
  }

  if (env.SERPAPI_API_KEY) {
    const client = new SerpApiClient({
      apiKey: env.SERPAPI_API_KEY,
      baseUrl: env.SERPAPI_BASE_URL,
      maxRequestsPerMinute: env.SERPAPI_MAX_RPM,
      defaultRetryAfterSeconds: env.SERPAPI_DEFAULT_RETRY_AFTER_SECONDS,
      costPerSearch: 1,
    });
    const localBusiness = new SerpApiLocalBusinessSource({
      client,
      creditsPerRequest: 1,
      maxPagesPerQuery: env.SERPAPI_MAX_PAGES_PER_QUERY,
    });
    registry.sources.set(localBusiness.name, localBusiness);
  }

  // Apollo (ADR-014/ADR-028) registers BOTH roles from one client so the
  // serial rate limiter spans search and enrichment — Apollo's per-minute
  // window is shared account-wide. A master API key is required.
  if (env.APOLLO_API_KEY) {
    const client = new ApolloClient({
      apiKey: env.APOLLO_API_KEY,
      baseUrl: env.APOLLO_BASE_URL,
      maxRequestsPerMinute: env.APOLLO_MAX_RPM,
      defaultRetryAfterSeconds: env.APOLLO_DEFAULT_RETRY_AFTER_SECONDS,
      costPerEnrichment: 1,
    });
    const people = new ApolloPeopleSource({ client, maxPagesPerQuery: env.APOLLO_MAX_PAGES_PER_QUERY });
    const enricher = new ApolloEnrichProvider({ client, costPerRecord: 1 });
    registry.sources.set(people.name, people);
    registry.enrichers.set(enricher.name, enricher);
  }

  // Model providers (M5, ADR-012/ADR-032). The registry stays EMPTY unless
  // configured — generation-disabled remains the baseline. GENERATE_MODEL_PROVIDER
  // narrows to one provider (or the fake); unset registers every keyed adapter
  // and the generate step resolves by preference (minimax > openai > anthropic).
  const modelSelection = env.GENERATE_MODEL_PROVIDER;
  if (modelSelection === "fake") {
    const fakeModel = new FakeModelProvider();
    registry.models.set(fakeModel.name, fakeModel);
  } else {
    if ((modelSelection === undefined || modelSelection === "openrouter") && env.OPENROUTER_API_KEY) {
      const openrouter = new OpenRouterModelProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        model: env.OPENROUTER_MODEL,
      });
      registry.models.set(openrouter.name, openrouter);
    }
    if ((modelSelection === undefined || modelSelection === "minimax") && env.MINIMAX_API_KEY) {
      const minimax = new MiniMaxModelProvider({
        apiKey: env.MINIMAX_API_KEY,
        baseUrl: env.MINIMAX_BASE_URL,
        model: env.MINIMAX_MODEL,
      });
      registry.models.set(minimax.name, minimax);
    }
    if ((modelSelection === undefined || modelSelection === "openai") && env.OPENAI_API_KEY) {
      const openai = new OpenAiModelProvider({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
        model: env.OPENAI_MODEL,
      });
      registry.models.set(openai.name, openai);
    }
    if ((modelSelection === undefined || modelSelection === "anthropic") && env.ANTHROPIC_API_KEY) {
      const anthropic = new AnthropicModelProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL,
        model: env.ANTHROPIC_MODEL,
      });
      registry.models.set(anthropic.name, anthropic);
    }
  }

  // Website research via Firecrawl is doubly opt-in (flag + key) so the default
  // stays free/offline and the module remains deferrable (ADR-027).
  if (env.WEBSITE_RESEARCH_PROVIDER === "firecrawl" && env.FIRECRAWL_API_KEY) {
    const client = new FirecrawlClient({
      apiKey: env.FIRECRAWL_API_KEY,
      baseUrl: env.FIRECRAWL_BASE_URL,
      maxRequestsPerMinute: 8,
      costPerScrape: 1,
    });
    const research = new FirecrawlWebsiteResearch({ client, costPerRecord: 1 });
    registry.researchers.set(research.name, research);
  }

  return registry;
}

export interface ProviderCatalogEntry {
  name: string;
  kind: "source" | "enrich" | "research" | "model" | "phone-validation" | "email-verification" | "contact-discovery";
  paid: boolean;
  connected: boolean;
  requiresEnv: string;
  description: string;
  /** Concrete vendor behind a capability entry (adapter built ≠ vendor selected; ADR-030). */
  vendor?: string;
}

/**
 * The full catalog of live providers the product can use, INCLUDING those not
 * yet configured (connected:false) — the registry alone cannot surface a
 * missing provider because unconfigured adapters are never registered.
 */
export function knownProviders(env: Env): ProviderCatalogEntry[] {
  return [
    {
      name: "local-business",
      kind: "source",
      paid: true,
      connected: Boolean(env.SERPAPI_API_KEY),
      requiresEnv: "SERPAPI_API_KEY",
      description:
        "Local-business discovery via SerpAPI's Google Maps engine (name, category, address, phone, website, rating, reviews).",
    },
    {
      name: "website-research",
      kind: "research",
      paid: true,
      connected: env.WEBSITE_RESEARCH_PROVIDER === "firecrawl" && Boolean(env.FIRECRAWL_API_KEY),
      requiresEnv: "FIRECRAWL_API_KEY",
      description: "Bounded business-website research via Firecrawl.",
    },
    {
      name: "professional-contacts",
      kind: "source",
      paid: false,
      connected: Boolean(env.APOLLO_API_KEY),
      requiresEnv: "APOLLO_API_KEY",
      description:
        "Professional/executive discovery via Apollo people search (name, title, employer, location). Search consumes no credits and returns NO emails or phone numbers; a MASTER API key is required.",
    },
    {
      name: "person-enrichment",
      kind: "enrich",
      paid: true,
      connected: Boolean(env.APOLLO_API_KEY),
      requiresEnv: "APOLLO_API_KEY",
      description:
        "Person enrichment via Apollo (~1 credit per matched record): work email (found, NOT verified), title, LinkedIn URL. Phone reveal requires Apollo's webhook and stays deferred (ADR-029).",
    },
    {
      name: "phone-validation",
      kind: "phone-validation",
      vendor: "twilio",
      paid: true,
      connected: env.PHONE_VALIDATION_PROVIDER === "twilio" && Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
      requiresEnv: "PHONE_VALIDATION_PROVIDER=twilio + TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN",
      description:
        "Phone validation via Twilio Lookup v2: per-signal line type, line status, and identity match — never a single 'verified' flag. Charged per requested signal package. Adapter built ≠ vendor selected (ADR-009 benchmark).",
    },
    {
      name: "email-verification",
      kind: "email-verification",
      vendor: env.EMAIL_VERIFICATION_PROVIDER === "millionverifier" ? "millionverifier" : "zerobounce",
      paid: true,
      connected:
        (env.EMAIL_VERIFICATION_PROVIDER === "zerobounce" && Boolean(env.ZEROBOUNCE_API_KEY)) ||
        (env.EMAIL_VERIFICATION_PROVIDER === "millionverifier" && Boolean(env.MILLIONVERIFIER_API_KEY)),
      requiresEnv: "EMAIL_VERIFICATION_PROVIDER=zerobounce|millionverifier + matching API key",
      description:
        "Email deliverability verification (valid/invalid/catch_all/unknown/role_based). Unknown results are not charged. Only a 'valid' result ever sets verified_email. Adapter built ≠ vendor selected (ADR-010 benchmark).",
    },
    {
      name: "contact-discovery",
      kind: "contact-discovery",
      vendor: env.CONTACT_DISCOVERY_PROVIDER === "fake" ? "bettercontact" : env.CONTACT_DISCOVERY_PROVIDER,
      paid: true,
      connected:
        (env.CONTACT_DISCOVERY_PROVIDER === "bettercontact" && Boolean(env.BETTERCONTACT_API_KEY)) ||
        (env.CONTACT_DISCOVERY_PROVIDER === "fullenrich" && Boolean(env.FULLENRICH_API_KEY)) ||
        (env.CONTACT_DISCOVERY_PROVIDER === "leadmagic" && Boolean(env.LEADMAGIC_API_KEY)),
      requiresEnv: "CONTACT_DISCOVERY_PROVIDER=bettercontact|fullenrich|leadmagic + matching API key",
      description:
        "Work email and direct/mobile phone discovery for approved records. Charged only on delivered data; discovered emails stay 'not_checked' until verified. Adapter built ≠ vendor selected (ADR-008 benchmark).",
    },
  ];
}
