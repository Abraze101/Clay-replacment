# Consolidated revision directive

Status: **active directive** — authoritative input for the next working session (2026-07-10). Supersedes conflicting statements in the other proposal documents; where it corrects `build-vs-adopt.md` or `database-schema.md`, this directive wins pending the verifications it mandates.

---

Read `CLAUDE.md` and every project document it references. Also read all three prior proposal documents in `docs/proposals/` — `milestone-0-plan.md`, `database-schema.md`, and `build-vs-adopt.md` — before revising anything. Do not implement code yet.

This prompt consolidates the original project architecture, the build-vs-adopt audit, the technical corrections, the UI direction, the MiniMax decision, and both the personal/free and managed-commercial delivery models.

Revise the project documentation and implementation plan accordingly, then stop for approval.

# 1. Product thesis

We are building a reusable lead-generation application inspired by the orchestration thesis in Angus Sewell's Clay-replacement video.

We are not recreating every Clay feature, integration, spreadsheet function or formula system.

The core loop is:

`describe market -> select/build workflow -> preview -> approve -> source -> normalize -> dedupe -> enrich -> validate -> score -> research -> review -> export`

The application must support prospects ranging from:

- A one-person roofing company
- Local service businesses
- Regional and multi-location SMBs
- Imported company/domain lists
- Owners and decision-makers
- CEOs and executives at larger US companies

The initial personal target is approximately 2,000 small-business leads per month.

The first practical use cases are:

- My health company finding potential B2B clients
- Marketing agencies finding clients
- Agencies finding B2B prospects for their clients
- Local-business cold-calling lists
- Professional and executive prospecting
- Imported-list enrichment

Health-company campaigns target businesses and professional contacts. Consumer or patient targeting based on health conditions, medical history or inferred sensitive information is outside scope.

# 2. One product, two delivery models

The same product must support both DIY/free operation and a managed commercial service.

Do not create separate codebases or incompatible workflow formats.

## DIY and personal use

A capable user can:

- Run the application locally
- Self-host it
- Connect personal provider accounts
- Connect a personal model provider
- Pay providers directly
- Maintain their own installation
- Export and retain control of their data
- Use documentation and community-level support

I may make this version freely available.

## Managed and supported use

Agency owners can pay me for:

- Hosting
- Setup
- Guided onboarding
- Provider connection assistance
- Workflow configuration
- Recommended templates
- Updates
- Backups
- Monitoring
- Troubleshooting
- Training
- Ongoing support
- Help adapting campaigns for different clients

The paid value is convenience, confidence, implementation assistance and maintenance—not merely access to the source code.

A future subscription around $49/month remains viable as a hosted platform and support fee. It must not promise unlimited premium enrichment.

Variable data costs remain separate, especially:

- Owner discovery
- Verified emails
- Direct/mobile numbers
- Live-line checks
- Premium firmographic data
- Expensive research operations

Initially, managed users should generally connect their own provider accounts. A future managed-credit system requires separate unit-economics and provider-resale review.

Do not implement subscription billing, Stripe, invoices or plan enforcement in the early milestones.

# 3. Primary user experience

The headless engine remains foundational, but the mature product should be an approachable application for nontechnical users.

Codex, Claude Code and OpenAI-compatible harnesses are the first beta interfaces. They are not the required permanent interface.

A normal user should not need to understand:

- MCP
- JSON
- Workflow schemas
- Command-line tools
- API field masks
- Provider-specific configuration
- Model-provider internals

The eventual product experience should allow a user to say:

"Find 500 roofing companies around Dallas with working websites and public phone numbers. Prioritize companies that appear capable of spending on advertising."

The application interprets that request into a strict, typed workflow and shows the user what it understood before execution.

# 4. Architectural boundaries

Keep the application model-neutral and harness-neutral.

The architecture should consist of:

1. **Core engine**
   - Workflow definitions
   - Validation
   - Execution
   - State transitions
   - Deduplication
   - Scoring
   - Approval enforcement
   - Cost controls
   - Exports

2. **Application services**
   - Workflow management
   - Run preview/start/status/results
   - Provider orchestration
   - Lead review
   - Credential requirements
   - Usage accounting

3. **Storage**
   - PostgreSQL as the durable system of record
   - PGlite for local embedded development where appropriate
   - Migrations
   - Repositories
   - Persistent run state

4. **Background execution**
   - Persistent jobs
   - Retries
   - Rate-limit handling
   - Crash recovery
   - Scheduled continuation

5. **Provider adapters**
   - Local-business sourcing
   - Professional/executive sourcing
   - Website research
   - Phone discovery
   - Phone validation
   - Email discovery
   - Email verification
   - Model generation
   - Optional CRM exports

6. **Interfaces**
   - CLI
   - MCP over stdio
   - MCP over Streamable HTTP
   - Web application
   - Future packaged desktop/self-hosted interface

The CLI, MCP server, web UI and embedded AI assistant must call the same application services. Do not duplicate business logic between interfaces.

# 5. Workflow engine

A workflow is a versioned JSON/YAML configuration assembled from approved typed steps.

Supported step types include:

- `source`
- `normalize`
- `dedupe`
- `enrich`
- `filter`
- `research`
- `score`
- `generate`
- `review_gate`
- `export`

Initial workflows should be linear with simple conditions and bounded retries. Do not build a general DAG engine initially.

Workflows may not execute:

- Arbitrary JavaScript
- Shell commands
- Dynamically downloaded code
- Unregistered providers
- Unknown step types

Workflow versions become immutable once used by a run.

The reusable workflow builder remains a core capability. Most users begin with templates and natural-language configuration. A simple ordered-step editor can later appear under an Advanced option.

Do not build a complex node canvas or Clay-style spreadsheet formula engine.

# 6. Built-in workflow families

## Local-business discovery

Use for roofers, plumbers, HVAC companies, gyms, clinics, contractors, restaurants, med spas and other category/location-driven businesses.

Expected flow:

`local source -> normalize -> dedupe -> website research -> optional owner/person enrichment -> local score -> optional personalization -> review -> export`

Important behaviors:

- Include service-area businesses where supported.
- A business remains a valid lead without an owner name or Apollo match.
- Preserve the public business phone as `business_main`.
- Never relabel it as the owner's direct or mobile number.
- Keep source metadata and retrieval time.
- Apply provider storage and attribution rules.
- Shortlist before expensive owner enrichment.

## Professional and executive discovery

Expected flow:

`Apollo/company-person search -> preview -> approval -> enrich -> dedupe -> executive score -> optional research/personalization -> review -> export`

Inputs may include:

- Title
- Seniority
- Geography
- Industry
- Revenue
- Headcount
- Technology
- Ownership
- Company type

## Imported-list enrichment

Expected flow:

`CSV/domain/URL import -> validate -> normalize -> dedupe -> website research -> optional company/person enrichment -> score -> review -> export`

Imported lists may contain:

- Company names
- Domains
- URLs
- Existing phones
- Existing emails
- Partial contacts

# 7. Enrichment presets

Keep three understandable presets.

They compile into visible typed workflow steps rather than hidden behavior.

## Quick List

Designed to source and normalize leads inexpensively.

For local businesses this may include:

- Business name
- Category
- Address
- Service area
- Website
- Public business phone
- Stable source identifier
- Source and retrieval time
- Basic phone parsing
- Domain normalization
- Deduplication
- CSV export

Do not run paid person/contact enrichment by default.

## Call-Ready

Starts from Quick List and adds selected validation or contact-discovery capabilities.

Possible additions:

- Phone format validity
- Line type
- Carrier/network line status
- Business or person association when available
- Additional business/direct/mobile discovery
- Work email discovery when requested
- Email verification
- Timezone
- Call-readiness status
- Suppression/compliance-review status
- Grounded cold-call notes

Do not automatically run every validation signal across every lead. The user selects the required depth and approves the cost.

## Full Enrichment

Adds:

- Owner or decision-maker discovery
- Verified work email
- Direct/mobile discovery
- Deeper firmographics
- Public-site research
- Deterministic fit score
- Structured AI fit rationale
- Personalized opener
- Evidence and prompt version
- Review state

The user can override individual capabilities:

- Accept business main phones
- Require direct/mobile phones
- Find owner
- Find email
- Validate email
- Accept or reject catch-all/unknown email
- Run phone status checks
- Skip personalization

The intended cost strategy is to source and score approximately 2,000 businesses, then deeply enrich only the best 20–30%.

# 8. Contact-data honesty

Never represent contact validation with one vague `verified` boolean.

For every phone, preserve available signals separately:

- Original value
- Normalized E.164 value
- Parse/format validity
- Phone role
- Line type
- Carrier/network status
- Reachability signal
- Business/person association
- Source provider
- Validation provider
- Validation method
- Checked-at time
- Confidence
- Raw provider status in bounded metadata

Phone roles include:

- `business_main`
- `direct`
- `mobile`
- `toll_free`
- `unknown`

Format-valid does not mean reachable.

Line type does not prove association with the intended owner.

A public number does not mean legally cleared for calling.

For email, distinguish:

- `valid`
- `invalid`
- `catch_all`
- `unknown`
- `role_based`
- `not_checked`

Discovery does not equal verification.

# 9. Cold-calling behavior

The application prepares lists for human callers. It does not place calls or operate a predictive dialer.

A call-ready export should include:

- Business
- Contact name/title when known
- Business main phone
- Direct/mobile phone when available
- Normalized phone
- Phone role
- Line type
- Validation method and status
- Source
- Last checked time
- Timezone
- Call-readiness state and reason
- Email status
- Suppression/compliance-review state

Call-readiness states may include:

- `ready`
- `uncertain`
- `invalid`
- `suppressed`
- `unchecked`

Maintain entity-specific suppression records. Apply them before every default call-ready export.

Do not claim a lead is legally cleared simply because a phone is public or appears to be a business line.

# 10. Durable runs and approval gate

LLM conversations must not own run state.

A user must be able to:

- Close a conversation
- Switch from Claude to Codex
- Restart the application
- Return later
- Retrieve the same run status and results

Every run pins an immutable workflow version.

The engine must support:

- Preview
- Start
- Status
- Pause
- Resume
- Cancel
- Retry
- Partial results
- Review
- Export

Paid actions require:

1. A resolved preview
2. Estimated paid actions
3. Record cap
4. Credit/dollar limit
5. Explicit user approval
6. Short-lived approval token
7. Exact scope verification when the job is claimed

The approval must bind:

- Workflow version
- Inputs
- Enrichment profile
- Capability overrides
- Record cap
- Budget
- Providers
- Estimated actions
- Plan hash

Changing the profile, enabling a new waterfall or raising the cap invalidates the approval and requires a new preview.

Harness approval UI and engine approval are separate protections. The engine must reject an unapproved run even if the harness invokes the tool.

# 11. Idempotency and paid-provider safety

Internal idempotency is necessary but does not guarantee provider-side idempotency.

For every paid provider adapter, document:

- Whether it accepts an idempotency key
- Whether it returns a stable request ID
- Whether ambiguous requests can be reconciled
- Whether failures consume credits
- Which errors are retryable
- Which outcomes require manual review

Persist:

- Internal request key
- Provider request ID
- Attempt number
- Attempt state
- Cost
- Provider response classification
- Checked/reconciled time

If a request may have completed but the provider cannot confirm its outcome, mark it ambiguous/manual review. Do not automatically retry and risk paying twice.

Do not describe `run_item_steps.request_key` as the sole universal credit-safety guarantee.

# 12. Data model

PostgreSQL remains the system of record.

Use ordinary typed columns with small bounded JSON metadata. Do not build EAV or a generalized data warehouse.

The proposed model should cover:

- Agencies/workspaces
- Users when authentication arrives
- Workflows
- Immutable workflow versions
- Leads
- Lead sources
- Contact points
- Append-only contact checks
- Runs
- Run items
- Run-item steps and costs
- Approval tokens
- Generated outputs
- Suppressions
- Exports
- Identity conflicts where required

Identity strategy:

## Businesses

- Provider/place ID
- Normalized domain as a non-exclusive matching signal
- Phone plus locality as a non-exclusive matching signal

## People

- Provider person ID
- LinkedIn URL supplied by an approved provider/import
- Verified email, while accounting for shared or role-based addresses

Do not merge on name alone.

Weak identifiers can collide legitimately. Flag conflicts instead of force-merging.

A business with no owner or contact remains a valid lead.

The current database-schema proposal remains proposed until the Milestone 0 vertical slice validates it. Review whether every proposed M0 table is required immediately and move safe additive capabilities to later migrations where appropriate.

# 13. Build-versus-adopt decisions

The research conclusion remains:

- There is no complete open-source Clay replacement suitable to adopt.
- Build the differentiated engine.
- Buy compliant data.
- Adopt mature libraries for commodity infrastructure.
- Study relevant projects without inheriting unsuitable licenses or architecture.

## Milestone 0 dependency direction

Accept or evaluate:

- Node 22 LTS
- Strict TypeScript
- Zod 4
- Kysely
- PGlite for embedded/local development
- PostgreSQL for hosted operation
- `csv-stringify` and `csv-parse`
- `libphonenumber-js/max`
- `tldts`
- Existing test/lint/build tooling
- Fake providers only

## Corrections to the research report

Current Kysely includes official PGlite support. Remove the community-shim/custom-dialect claim.

Current pg-boss supports PGlite through `fromPglite`. Remove the claim that pg-boss cannot operate with PGlite.

Because that support is new, perform a bounded compatibility spike covering:

- Filesystem persistence
- Start/stop/restart
- Job recovery
- Retry/backoff
- Duplicate-claim prevention
- Cancellation
- Modest concurrency
- Interaction with application transactions where supported

Adopt pg-boss only after the spike passes. Keep it behind a `JobQueue` interface.

Distinguish pg-boss job-delivery guarantees from third-party paid-call side effects.

Defer `json-rules-engine`. Start with a small typed deterministic operator allowlist. Reconsider a general rules engine only when real workflow complexity justifies it.

Keep Foursquare OS Places optional. It is a large data/operations commitment, not a trivial adapter.

Keep BetterContact, FullEnrich and LeadMagic as discovery benchmark candidates. Do not select one solely from marketing claims.

Benchmark using:

- Match rate
- Accuracy
- Attribution
- Cost per usable result
- Latency
- API reliability
- Webhook/reconciliation behavior
- Ambiguous request handling
- Provider and resale terms

Twilio remains a strong first phone-validation candidate because its signals map cleanly to the validation model. Telnyx or another provider may later demonstrate provider neutrality.

ZeroBounce, MillionVerifier or other email verifiers remain benchmark decisions.

Use an ADR-style decision registry with:

- Decision
- Date
- Evidence
- Reason
- Status
- Revisit trigger

Do not use "never relitigate" for libraries or vendors. Platform scraping prohibitions can remain project-level guardrails.

# 14. Provider strategy

## Local-business sourcing

Use the official Google Places API or another approved local-business provider.

Do not scrape Google Maps.

The adapter must:

- Use precise field masks
- Estimate cost from requested fields
- Expose geographic/query coverage limits
- Preserve Place IDs
- Track retrieval time
- Apply attribution
- Follow caching/storage restrictions
- Expire or refresh restricted snapshots
- Avoid treating one provider as complete market coverage

Public-business facts may also be researched from the business's own website within crawl limits.

## Website research

Use a lean policy-controlled fetcher rather than a stealth crawler.

Likely components at the appropriate milestone:

- Standard HTTP client
- `robots-parser`
- `cheerio`
- `p-queue`
- Response-size limits
- Timeouts
- Redirect limits
- Content-type checks
- Per-domain rate limits

Do not use fingerprint spoofing, CAPTCHA evasion, login bypasses or anti-bot circumvention.

## Professional sourcing

Apollo remains the first professional/executive provider candidate.

Apollo MCP is for interactive prototyping and read-oriented verification. Production workflows use a typed adapter over official APIs.

Do not expose sequence enrollment, messaging, contact creation or CRM mutation without a separately approved milestone.

Apollo standard plans cannot automatically be assumed to permit data resale or powering an external customer product. Personal/internal use and customer-owned accounts are the initial path. A managed-credit version requires an appropriate agreement.

## LinkedIn

Do not scrape LinkedIn or automate:

- Browsing
- Profile collection
- Messaging
- Invitations
- Contact downloads

A LinkedIn URL may enter through:

- Apollo
- Imported customer data
- An approved LinkedIn integration

Treat it as an identifier, not permission to scrape.

# 15. Model-provider strategy

MiniMax M3 is the likely first embedded model provider.

Use it for:

- Natural language to typed workflow drafts
- Preview explanations
- Company/website summaries
- Fit rationale
- Cold-call notes
- Personalized openers
- Configuration assistance

MiniMax must not:

- Call lead providers outside application services
- Bypass cost preview
- Bypass approval
- Write directly to the database
- Mark contact information verified
- Become the sole qualification authority
- Own run state
- Become required for deterministic sourcing and export

Keep a shared model-provider interface supporting MiniMax, OpenAI and Anthropic adapters.

The MCP client model and workflow generation model are separate choices.

A workflow must still source, normalize, dedupe, score and export when AI generation is disabled.

All model outputs require runtime schema validation and must be grounded in persisted evidence. Unsupported or uncertain claims must be omitted or flagged.

# 16. Harness and MCP compatibility

The engine must remain usable from:

- Claude Code
- Codex desktop/CLI/IDE
- OpenAI Agents SDK clients
- Future compatible clients
- CLI automation
- The web UI

Initial MCP tools include:

- `workflow_create`
- `workflow_validate`
- `workflow_list`
- `run_preview`
- `run_start`
- `run_status`
- `run_cancel`
- `run_results`
- `lead_review_update`
- `run_export_csv`

Use strict stable schemas and a consistent result envelope containing:

- `ok`
- `data`
- `summary`
- `warnings`
- `requestId`
- Permitted `nextActions`

Annotate read-only versus mutating/destructive tools.

Use:

- Stdio for local operation
- Streamable HTTP for remote/shared operation

Do not implement legacy SSE.

Both transports must expose the same tools, schemas and application behavior.

Confine MCP SDK imports to the MCP adapter.

Use the current stable MCP TypeScript SDK line until the newer major version is actually stable. Treat projected release dates as forecasts, not guarantees.

Do not add project Codex MCP configuration until the tested executable/start command exists.

MCP compatibility tests use fake providers and no live model credentials.

# 17. Minimum UI

The UI should be deliberately small and approachable.

## Home

- Start a new lead list
- Recent runs
- Saved templates
- Provider status

## Guided request

Accept plain English and show editable interpreted fields:

- Category/industry
- Geography
- Quantity
- Company size
- Titles/seniority
- Required contact information
- Qualification criteria
- Enrichment depth

## Preset selection

Offer:

- Quick List
- Call-Ready
- Full Enrichment

Expose understandable capability toggles rather than provider jargon.

## Provider setup

For each provider:

- Explain what it supplies
- Link to account/key instructions
- Accept credentials securely
- Test without spending credits when possible
- Show connected/missing/failed state
- Explain likely charges

## Preview

Show:

- Expected lead count
- Coverage limitations
- Providers
- Free steps
- Paid steps
- Estimated cost/credits
- Record cap
- Validation depth
- Storage/attribution notices
- Approval button

## Progress

Show:

- Current stage
- Sourced count
- Duplicates
- Qualified count
- Enrichment success/failure
- Credits spent
- Paused/retry/manual-review states
- Cancel action

## Results

Show:

- Business/person
- Website
- Location
- Public phone
- Direct/mobile phone
- Contact role
- Validation status
- Email status
- Fit score and reason
- Source
- Evidence
- Suppression state
- Review state

Support:

- Filtering
- Selection
- Review updates
- Export
- Continuing only selected leads into deeper enrichment

The initial UI is not:

- A spreadsheet formula engine
- A node canvas
- A connector marketplace
- An analytics platform
- A collaborative enterprise workspace

# 18. Credential handling

Secrets must never appear in:

- Repository files
- Prompts
- Fixtures
- Screenshots
- Logs
- CSV exports
- MCP responses

## DIY mode

- Credentials remain inside the user's installation
- Environment/secret storage is documented
- The user pays providers directly

## Managed mode

- Credentials are encrypted per workspace
- Stored server-side only
- Not visible after entry
- Never exposed to the model
- Never exposed in support diagnostics
- Rotatable and deletable

The application should know whether a required provider is connected without exposing its secret.

# 19. Deployment strategy

## Local development

- PGlite where practical
- Fake providers
- CLI
- Stdio MCP
- No external credentials
- No credit-consuming calls

## Personal VPS

Use:

- Real PostgreSQL
- Background worker
- Application/API service
- Guided web UI
- Minimal authentication
- Encrypted credentials
- Backups
- Health monitoring
- Usage/cost accounting
- Authenticated Streamable HTTP MCP

The personal VPS deployment can become the managed beta environment later.

## Managed beta

Add only:

- Workspace isolation
- Invited users
- Per-workspace secrets
- Usage and spending limits
- Backup verification
- Operational diagnostics
- Basic support administration

Do not add enterprise infrastructure prematurely.

## DIY distribution

After the hosted version is stable, evaluate:

- Documented Docker Compose
- One-command installer
- Packaged desktop application

Do not make desktop packaging an early milestone.

# 20. Recommended milestone progression

Revise the existing milestone plan around the following proposed sequence. If a different ordering is technically safer, explain it before changing it.

## Milestone 0: engine skeleton

Deliver:

- Strict TypeScript project
- Dependency/version policy
- Environment validation
- PGlite/local storage setup
- Proposed schema migration
- Typed workflow schemas
- Approved step allowlist
- Workflow versioning
- Fake provider
- Persistent fake run
- Preview and approval scope
- Run state transitions
- CLI operations
- CSV export
- Tests
- pg-boss/PGlite compatibility spike

No MCP, UI, live providers or model providers.

Acceptance:

- Fake workflow persists and completes
- Restart/resume works
- Unknown steps fail
- Approval changes are detected
- Duplicate paid-style fake steps do not repeat
- CSV export is safe
- Lint, typecheck, tests and build pass
- No credentials or network calls are required

## Milestone 1: harness adapter

Deliver:

- Stable MCP tool contract
- Stdio transport
- Streamable HTTP transport
- Approval-token registry
- Tool annotations
- Pagination and structured results
- Claude Code compatibility
- Codex compatibility
- OpenAI Agents SDK fixture

Acceptance:

- All harnesses operate the same fake workflow
- Shared state survives switching harnesses
- Transports expose equivalent tools
- Mutations fail without engine approval
- No live provider/model credentials are required

## Milestone 2: minimal usability UI

Deliver a bare-bones UI over the fake provider and existing application services.

Acceptance:

- A nontechnical tester can define, preview, approve, run, monitor, review and export without the CLI or an external LLM harness
- No business logic is duplicated in the UI

## Milestone 3: local-business workflow

Deliver:

- Official local-business provider adapter
- Category/geography/service-area inputs
- Storage/attribution handling
- Website normalization
- Bounded website research
- Local dedupe
- Quick List workflow
- Cost previews from actual field masks
- Useful public-business-phone export

CI remains fixture-only.

## Milestone 4: professional and imported workflows

Deliver:

- Apollo search/enrichment adapter
- Executive workflow
- Imported CSV/domain workflow
- Provider retry policy
- Preview and bounded enrichment
- Identity conflict handling

CI remains fixture-only.

## Milestone 5: contact enrichment and MiniMax assistance

Deliver:

- Provider-neutral discovery interfaces
- Phone validation interfaces
- Email verification interfaces
- Append-only validation history
- Call-readiness policy
- Discovery-provider benchmark
- MiniMax adapter
- Shared model-provider interface
- Grounded rationale and opener
- Selected-lead continuation into deeper enrichment

## Milestone 6: personal VPS and managed beta

Deliver:

- Real PostgreSQL deployment
- Background worker deployment
- Guided hosted UI
- Authentication
- Encrypted credentials
- Backups
- Monitoring
- Workspace isolation
- Operational limits
- Managed-beta onboarding

Billing remains a separate later decision.

# 21. Explicit non-goals

Do not add:

- Full Clay spreadsheet/formula parity
- Arbitrary workflow code
- LinkedIn scraping
- Google Maps scraping
- Autonomous email sending
- Automated LinkedIn actions
- Predictive dialing
- CRM writes without explicit approval
- Consumer/patient targeting based on sensitive health data
- Billing in early milestones
- Enterprise SSO/RBAC
- Connector marketplace
- General event/audit platform
- Complex analytics
- Large node-canvas builder

# 22. Requested documentation work

Before implementation:

1. Update the product requirements to support DIY/free and managed operation.
2. Update the UI scope so a minimal UI is expected after the harness vertical slice.
3. Update the architecture diagram to include:
   - CLI
   - MCP
   - Web UI
   - Embedded MiniMax assistant
   - Shared application services
   - PostgreSQL/jobs/providers
4. Update workflow documentation with the three presets and UI-guided flow.
5. Correct the build-vs-adopt report.
6. Convert permanent vendor/library decisions into ADR entries with revisit triggers.
7. Review and correct the proposed database schema.
8. Update harness compatibility without making any model provider architectural.
9. Update the implementation milestones.
10. Update the Claude handoff prompts.

Then provide:

- A change summary
- Accepted decisions
- Corrected decisions
- Deferred decisions
- Remaining open decisions
- Revised dependency list by milestone
- Revised migration plan
- Revised touched-file plan
- Test strategy
- Security risks
- Provider/commercial terms risks
- Exact Milestone 0 plan

Do not write implementation code, call live providers, authenticate services, spend credits, change remote infrastructure or deploy to the VPS.

Stop after the revised documentation and Milestone 0 plan and wait for approval.
