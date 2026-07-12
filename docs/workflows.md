# Execution workflows

## How it runs

Two front doors drive the same application services: an LLM harness conversation (Claude Code, Codex, or another supported client calling the engine's MCP tools) and the guided web UI expected at Milestone 2. The CLI exposes the same operations for debugging and automation. No interface owns run state; the engine does.

Example harness conversation:

```text
User: Find independent roofing businesses around Austin that might need our service.

Assistant:
1. Selects the local-business workflow.
2. Asks for any missing offer/qualification inputs.
3. Calls workflow_create or reuses a saved template.
4. Calls run_preview and explains sample coverage/cost.
5. Waits for approval.
6. Calls run_start.
7. Checks run_status and presents results.
8. Applies review updates and exports approved leads.
```

The run continues in the engine even if the conversation closes or the user switches LLM clients.

### UI-guided flow

The guided UI walks a nontechnical user through the same loop without exposing MCP, JSON, or workflow schemas:

1. Plain-English request (for example, "Find 500 roofing companies around Dallas with working websites and public phone numbers").
2. Editable interpreted fields: category/industry, geography, quantity, company size, titles/seniority, required contact information, qualification criteria, enrichment depth.
3. Preset selection with understandable capability toggles.
4. Provider setup and connection status.
5. Preview showing free versus paid steps, record cap, coverage limits, and estimated cost.
6. Explicit approval.
7. Progress with sourced/duplicate/qualified counts, credits spent, and paused/retry/manual-review states.
8. Results review, selection, review updates, and export, including continuing only selected leads into deeper enrichment.

Both paths produce the same typed workflow, the same preview, and the same approval requirement.

## Choosing enrichment depth

The harness or guided UI asks what the list is for, then proposes a preset:

| Goal | Default preset | Behavior |
|---|---|---|
| "Give me a quick list of roofers from Google Maps" | Quick List | Source fields, normalization, dedupe, and CSV; no person/contact waterfall. |
| "Give my callers a list they can dial" | Call-Ready | Business and optional direct phones, validation signals, timezone, grounded cold-call notes, email if requested, and call-readiness status. |
| "Build a deeply researched outreach list" | Full Enrichment | Call-Ready plus firmographics, research, scoring, and personalization. |

Full Enrichment guidance: source and score a large set—roughly 2,000 businesses for a typical monthly campaign—then deeply enrich only the best 20–30%. Do not pay for owner discovery, verified emails, or direct/mobile numbers across the whole sourced set.

The user can say, for example, "Call-Ready, but business main numbers are fine and skip email" or "Find a mobile decision-maker number and a conservatively verified work email." The resolved steps and likely paid actions are shown before the run begins.

## CLI equivalents

The implemented command surface (M0/M1, plus the M3 `worker`; `run preview` issues the single-use approval token that `run start` consumes):

```text
leads workflow create --file workflow.json
leads workflow validate <workflow-id>
leads run preview <workflow-id> --inputs campaign.json
leads run start <workflow-id> --inputs campaign.json --approval <token>
leads run status <run-id>
leads run results <run-id> --status completed
leads run review <run-id> --approve --all
leads run resume <run-id> [--budget <n> --cap <n> --approval <fresh-token>]
leads run retry <run-id>
leads run cancel <run-id>
leads export csv <run-id>
leads worker
```

`leads worker` (M3) hosts a resident pg-boss worker for delayed rate-limit resumes. One-shot CLI runs self-heal short provider pauses inline; longer pauses (`runs.resume_at`) need a resident worker — `leads worker` or the web server. PGlite allows only one live process per `pglite://` directory; use a PostgreSQL `DATABASE_URL` to run the worker alongside another entry.

## Workflow 1: local business discovery

Use for roofers, plumbers, gyms, clinics, home-service businesses, restaurants, and other location/category-driven markets.

1. Search the local-business provider by category and geography.
2. Include service-area businesses when appropriate.
3. Normalize place ID, name, phone, address, domain, and locality.
4. Dedupe across previous runs.
5. Visit the public business website within crawl limits.
6. Extract business-level facts and public contact paths.
7. Shortlist before expensive owner enrichment: rank the sourced set with the local score and continue only selected rows into paid owner/person discovery.
8. Attempt Apollo company/person enrichment only for shortlisted rows whose identifiers support a reasonable match.
9. Score using local-market rules.
10. Generate a business-specific opener.
11. Review and export.

Important: a one-person business can be a useful lead even when no named owner or Apollo record is found.

For Quick List, stop after source, normalization, dedupe, and export. For Call-Ready, preserve the Google Maps main number, attempt additional contact discovery only for approved rows, and attach validation metadata without replacing the original source value.

## Workflow 2: executive/professional discovery

Use for founders, executives, department leaders, and employees at larger companies.

1. Translate title, seniority, geography, company size, industry, technology, and revenue criteria to Apollo search.
2. Preview 20 results without revealing contact data.
3. Approve enrichment for a bounded set.
4. Enrich people and companies.
5. Dedupe by Apollo ID, LinkedIn URL, and verified email.
6. Score against the campaign ICP.
7. Generate a grounded rationale and opener.
8. Review and export.

## Workflow 3: imported list

Use when the user already has company names, domains, URLs, or partial contacts.

1. Import and validate CSV/JSON.
2. Normalize domains, phones, names, and locations.
3. Dedupe against existing leads.
4. Research the public business website.
5. Enrich through Apollo when identifiers match.
6. Score, personalize, review, and export.

## Growth path from local to national

The same saved campaign can evolve without changing products:

1. Start with a local-business template for one category and metro.
2. Expand into multiple metros or states through bounded, deduplicated query batches.
3. Add company-size, revenue, location-count, and industry filters for larger accounts.
4. Switch or combine the Apollo company/person source when named decision-makers become important.
5. Reuse the scoring and offer template while changing the source and contact requirements.

This preserves thorough local coverage while adding stronger firmographic and role targeting for larger US businesses.

Meta Ads remains a service or delivery channel used by many agencies; it is not the discovery database for this MVP. Approved Meta lead exports can later enter through the imported-list workflow.

## Health-company campaigns

The same workflows can find business clients for the user's health company—for example clinics, providers, employers, partners, or professional decision-makers.

If the intended leads are individual patients or consumers selected using health conditions, medical history, or inferred health status, stop. That requires a separate privacy, consent, legal, and data-governance design.

## Cold-calling list behavior

The engine prepares lists but does not place calls. Each phone receives a role such as `business_main`, `direct`, `mobile`, `toll_free`, or `unknown`, plus the exact validation signals available. A formatted number is not automatically considered reachable, associated with the intended person, or cleared for calling.

Before export, the engine applies the agency/client's entity-specific suppression list and records `ready`, `uncertain`, `invalid`, `suppressed`, or `unchecked` with a reason. Records that have not undergone the requested compliance review remain visibly `unchecked`; they are never silently treated as cleared.

## Workflow-builder behavior

The LLM harness—or the embedded assistant (MiniMax, arriving at Milestone 5)—may:

- Select a built-in workflow.
- Draft a typed workflow from a plain-English request and explain the resolved preview.
- Clone and parameterize a template.
- Insert/remove approved step types.
- Change provider-neutral filters and scoring rules.
- Validate required credentials and step compatibility.

Neither the harness nor the embedded assistant may:

- Insert arbitrary executable code.
- Bypass a review/approval gate.
- Add an unknown provider without an implemented adapter.
- Turn on paid enrichment or outbound actions without approval.

## Failure behavior

| Failure | Behavior |
|---|---|
| Source limit | Explain coverage limits and suggest a bounded geographic/query split. |
| Provider `429` | Pause and retry after the limit window. |
| Credit cap reached | Stop before the next paid item and keep partial results. |
| Paid call outcome unconfirmable | Mark the step `needs_review`; never auto-retry a possibly-completed paid call. |
| Phone only format-valid | Keep it, label the validation level accurately, and do not claim reachability. |
| Invalid/inactive phone | Retain source history but exclude it from the default call-ready export. |
| Suppressed contact | Never include it in a callable export unless an authorized operator removes the suppression. |
| No Apollo match | Keep the business lead; mark contact enrichment unavailable. |
| Duplicate | Attach the existing lead to the new run/workflow result. |
| Conflicting identity | Flag; do not merge automatically. |
| Website unavailable | Continue with source data and mark research incomplete. |
| Invalid AI output | Retry once, then leave the lead usable without generated copy. |
