# Product requirements

## Product thesis

The product is a reusable lead-generation engine that can find and enrich very different kinds of prospects—from a one-person roofing business to a CEO at a large company—by selecting the right sourcing workflow for the market.

Claude Code, Codex, and OpenAI-compatible harnesses are the first beta interfaces, not the required permanent interface. The user describes the market and desired output; the harness or the guided application creates or selects a workflow, previews the plan, runs it through the lead engine, and returns reviewable results.

The mature product is an approachable application for nontechnical users. A user should be able to say "Find 500 roofing companies around Dallas with working websites and public phone numbers. Prioritize companies that appear capable of spending on advertising," and the application interprets that request into a strict typed workflow and shows what it understood before execution. A normal user never needs to understand MCP, JSON, workflow schemas, command-line tools, API field masks, provider-specific configuration, or model-provider internals.

The durable headless application layer is foundational regardless of interface. It stores workflows and leads, controls costs, resumes jobs, prevents duplicates, and exports results.

The initial personal target is approximately 2,000 small-business leads per month. The intended cost strategy is to source and score broadly, then deeply enrich only the best 20–30%.

## Delivery models

One codebase and one workflow format serve two delivery models. Do not fork them.

1. **DIY/free**: a capable user runs the application locally or self-hosts it, connects personal provider accounts and a personal model provider, pays providers directly, retains and exports their own data, and maintains their own installation with documentation and community-level support. This version may be made freely available.
2. **Managed**: agency owners pay for hosting, setup, guided onboarding, provider-connection assistance, workflow configuration, recommended templates, updates, backups, monitoring, troubleshooting, training, ongoing support, and help adapting campaigns for different clients. The paid value is convenience, confidence, implementation assistance, and maintenance—not access to the source code.

A future subscription around $49/month remains viable as a hosted platform and support fee. It must not promise unlimited premium enrichment. Variable data costs stay separate—especially owner discovery, verified emails, direct/mobile numbers, live-line checks, premium firmographic data, and expensive research operations. Managed users initially connect their own provider accounts; a managed-credit system requires a separate unit-economics and provider-resale review.

Do not implement subscription billing, Stripe, invoices, or plan enforcement in the early milestones.

## Target use cases

- The user's own health company finding potential B2B clients.
- Marketing agency owners finding prospects for their agency.
- Small agencies running separate lead campaigns for clients.
- Local-service prospecting, such as roofers, plumbers, HVAC companies, contractors, clinics, gyms, med spas, or home-service companies.
- Professional/executive prospecting, such as founders, owners, directors, and CEOs.
- Imported company/domain lists that need contact enrichment.
- Call-ready list building for human cold callers who need usable business, direct, or mobile phone numbers and clear validation status.

Health-company scope in the MVP means businesses and professional contacts. Consumer or patient acquisition based on health conditions is a separate privacy/compliance project and is not assumed here.

## Market scope

The product is intentionally horizontal across business size and geography:

1. **Local/micro businesses**: owner-operated companies and small service-area businesses in a city or metro.
2. **Regional SMBs**: multi-location or growing companies across several metros or states.
3. **National and larger companies**: companies and professional decision-makers across the United States.

The workflow inputs—not separate products—control geography, industry/category, company size, revenue, headcount, ownership, title, seniority, and contact requirements. New providers can be added behind adapters when one source cannot cover a market thoroughly.

Many target users deliver leads through Meta Ads. This MVP finds and enriches B2B prospects for those agencies, their clients, or the user's health company; it does not manage Meta campaigns or replace a Meta lead inbox. A future imported-list adapter may accept an approved Meta Lead Ads export without changing the core engine.

## Why multiple sourcing workflows are necessary

Apollo is well suited to professional contacts represented in company and employment data. It should not be the only discovery path for very small local businesses.

The MVP therefore includes three workflow families:

1. **Local business discovery**: local/place search -> business website -> public business/contact extraction -> optional Apollo match/enrichment.
2. **Professional/executive discovery**: Apollo company/people search -> enrichment -> scoring/personalization.
3. **Imported list enrichment**: CSV/domains/URLs -> normalize/dedupe -> Apollo and website enrichment -> scoring/personalization.

## Workflow builder

A workflow is a versioned JSON/YAML configuration assembled from approved step types. Most users start from templates and natural-language configuration through the guided application or a connected LLM harness; a simple ordered-step editor may later appear under an Advanced option.

Supported MVP step types:

- `source`: produce candidate businesses or people.
- `normalize`: clean domains, names, phones, locations, and identifiers.
- `dedupe`: resolve exact stable identifiers.
- `enrich`: retrieve provider data for approved records.
- `filter`: apply campaign criteria and exclusions.
- `research`: retrieve permitted public business-website context.
- `score`: calculate transparent fit rules.
- `generate`: create structured fit summaries and personalization.
- `review_gate`: require user approval before paid or external actions.
- `export`: create CSV and later CRM upserts.

Workflow configurations may use conditions and bounded retries, but they may not execute arbitrary user-authored JavaScript or shell commands.

## Enrichment profiles

Enrichment is optional and selected per run. The MVP provides three understandable presets instead of one vague on/off switch:

1. **Quick List**: discover and normalize leads without paid person/contact enrichment. A Google Maps run returns available business name, category, address/service area, public main phone, website, rating/review metadata, and source ID.
2. **Call-Ready**: start from the quick list, find additional business or decision-maker phones when identifiers support a credible match, validate each number, classify line type, find/verify work email when requested, attach timezone and optional grounded cold-call notes, and produce a call-readiness status. The user selects the required depth and approves the cost; validation signals never run automatically across every lead.
3. **Full Enrichment**: include Call-Ready plus deeper company/person firmographics, public-site research, scoring, evidence-grounded personalization, and any approved optional fields.

The user can override individual capabilities inside a preset:

- Find additional phone numbers.
- Validate existing phone numbers.
- Require a direct/mobile number or accept a business main line.
- Find work email.
- Validate email and decide whether catch-all/unknown results are acceptable.
- Find a named owner or decision-maker.
- Skip personalization.

These presets compile into the same visible typed workflow steps. `run_preview` shows which steps will run, what data may be returned, the maximum number of paid records, estimated provider usage, and what validation level is available.

### Contact validation semantics

A phone number is not represented by a single `valid` boolean. Store separate signals where supported:

- Parse/format validity and normalized E.164 value.
- Line type such as business landline, mobile, VoIP, or toll-free.
- Carrier/network line status or reachability signal.
- Association with the business or named person.
- Source provider and last-checked timestamp.

Likewise, email status distinguishes `valid`, `invalid`, `catch_all`, `unknown`, `role_based`, and `not_checked`. A provider that only found an address must not be treated as having verified it.

### Cold-calling output

A call-ready export includes business name, contact name/title when known, business main phone, direct/mobile phone when found, normalized phone, phone role, line type, validation method and status, source, last checked time, timezone, call-readiness status/reason, email verification status, and suppression/compliance-review status.

Call-readiness states are `ready`, `uncertain`, `invalid`, `suppressed`, and `unchecked`. Records that have not undergone the requested compliance review remain visibly `unchecked`; unknown status is never treated as cleared.

The MVP prepares lists for human callers; it does not place calls or operate a predictive dialer. It maintains an entity-specific suppression list and never marks a record legally cleared merely because a number is public or classified as a business line. Federal and state calling requirements remain an operator responsibility and need a separate deployment-specific compliance review.

## Primary user jobs

1. Describe a market and offer in natural language.
2. Select a built-in workflow, or let the guided application or a connected LLM harness adapt one.
3. Preview sources, filters, result samples, and likely costs.
4. Approve the run and any paid enrichment.
5. Monitor status in the UI, conversationally, or by CLI.
6. Review, refine, and regenerate selected leads.
7. Export an approved result set.
8. Save the workflow as a reusable template.

## Headless MVP requirements

### Workflow management

- Create, validate, version, clone, list, and archive workflows.
- Validate step compatibility and required credentials before a run.
- Show the resolved execution plan before starting.
- Store immutable workflow version on each run.

### Runs

- Preview a workflow with a small no/low-cost sample.
- Require approval before credit-consuming steps.
- Persist progress and results independent of the LLM conversation.
- Pause, resume, cancel, and retry failed items.
- Initially cap paid enrichment at 100 records per run.

### Sources

- Apollo people/company search for professional leads.
- Google Places Text/Nearby Search or another approved local-business source for local discovery.
- CSV/domain/URL import.
- Public business-website research with clear crawl limits.
- Provider adapters must respect licensing, attribution, caching, and storage rules.

### Enrichment and dedupe

- Enrich person/company records through Apollo when a match is possible.
- Handle local businesses with no Apollo match as valid business leads.
- Preserve Google Maps/public business phones even when no person-level contact is found.
- Support provider-neutral phone discovery, phone validation, email discovery, and email verification capabilities.
- Keep every discovered contact point's source and validation history.
- Deduplicate by provider ID, place ID, normalized domain, LinkedIn URL, verified email, and phone where appropriate.
- Flag conflicting identifiers instead of merging on name alone.

### Qualification and personalization

- Score using market-specific rules.
- Allow different scoring templates for local businesses and executives.
- Ask a configured model provider—MiniMax, OpenAI, or Anthropic behind one shared interface—for structured rationale and personalization from saved evidence.
- MiniMax M3 is the likely first embedded model provider; sourcing, scoring, and export must still work with generation disabled.
- Prevent unsupported claims from entering outputs.

### Interfaces

- Provide a CLI for deterministic operation and debugging.
- Provide a standards-based MCP server so Claude, Codex, and OpenAI agents can create/preview/run/check/export workflows.
- Support stdio for local use and Streamable HTTP for a later remote/shared deployment.
- Provide a minimal web UI at Milestone 2, over the same application services as the CLI and MCP server, so a nontechnical user can define, preview, approve, run, monitor, review, and export without the CLI or an external LLM harness.

## Initial MCP/CLI operations

- `workflow_create`
- `workflow_validate`
- `workflow_list`
- `run_preview`
- `run_start`
- `run_status`
- `run_cancel`
- `run_resume`
- `run_retry`
- `run_results`
- `lead_review_update`
- `run_export_csv`

Every operation has strict input/output schemas and returns structured JSON suitable for any LLM harness, plus a human-readable summary for CLI use. `run_resume` continues past the review gate or a pause (a budget/cap change requires a fresh approval token), and `run_retry` requeues failed items without touching `needs_review` steps.

`run_preview` and `run_start` accept a validated `enrichmentProfile` plus typed overrides. Paid contact discovery or validation cannot silently start because a source returned new rows.

## Practical quality requirements

- Conversation loss must not lose a workflow or run.
- A retry must not repeat a completed paid enrichment step.
- Provider errors and limits must produce visible, retryable states.
- Secrets stay outside prompts and repository files.
- Tests use fake fixtures and do not spend provider credits.
- Local-business source data follows the provider's storage and attribution rules.

## Success criteria

- Claude, Codex, and an OpenAI Agents SDK client can each operate a local roofer workflow and an executive workflow through the same MCP contract.
- A one-person business without an Apollo match remains a usable business lead.
- A local campaign can export a useful Google Maps list without running any paid enrichment.
- The same campaign can be rerun or continued as Call-Ready, with phone/email checks applied only to the approved records.
- A cold-calling export never conflates a public business line, a direct number, and a mobile number or overstates the validation performed.
- A CEO lead can be discovered/enriched through Apollo and personalized.
- The user can close or switch LLM clients, return later, and retrieve the run status/results.
- A saved workflow can be reused with a different geography, industry, or client offer.
- A nontechnical tester can define, preview, approve, run, monitor, review, and export a run through the minimal UI without the CLI or an external LLM harness.
- DIY self-hosted operation and managed operation run from the same codebase and workflow format.
- Results export cleanly to CSV.

## Explicitly out of scope

- A full Clay spreadsheet/formula engine.
- Arbitrary code execution inside workflows.
- LinkedIn scraping or messaging automation.
- Google Maps scraping; local-business sourcing uses official APIs only.
- Autonomous outbound sending.
- Predictive dialing or placing calls.
- Meta Ads campaign creation, optimization, or consumer lead inbox management.
- Consumer/patient targeting based on sensitive health data.
- Subscription billing, Stripe, invoices, or plan enforcement in early milestones.
- Enterprise permissions, SSO, compliance dashboards, or data warehouses.
- A complex node-canvas UI in the first release.
