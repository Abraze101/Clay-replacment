# UI scope

A minimal usability UI is expected at Milestone 2, built over the fake provider and the existing application services. It is no longer conditional on "real usage showing a need." Claude Code, Codex, and OpenAI-compatible harnesses are the first beta interfaces, not the permanent required interface; the mature product is an approachable application for nontechnical users.

The UI is an adapter over the same application services as the CLI and MCP server. It duplicates no business logic, holds no run state, and never bypasses the engine's preview/approval gates. Milestone 2 acceptance: a nontechnical tester can define, preview, approve, run, monitor, review, and export a lead list without the CLI or an external LLM harness.

A UI user should never need to understand MCP, JSON, workflow schemas, command-line tools, API field masks, provider-specific configuration, or model-provider internals. The UI framework is an open decision recorded in `docs/decisions.md`, chosen at Milestone 2 planning.

## 1. Home

- Start a new lead list.
- Recent runs and their states.
- Saved templates.
- Provider connection status.

## 2. Guided request

Accept plain English — for example, "Find 500 roofing companies around Dallas with working websites and public phone numbers. Prioritize companies that appear capable of spending on advertising." — and show editable interpreted fields before anything executes:

- Category/industry.
- Geography.
- Quantity.
- Company size.
- Titles/seniority.
- Required contact information.
- Qualification criteria.
- Enrichment depth.

The request compiles into a strict typed workflow. The user sees and can correct what the application understood before execution.

## 3. Preset selection

Offer the three presets:

- Quick List.
- Call-Ready.
- Full Enrichment.

Expose understandable capability toggles — find owner, find email, validate email, accept or reject catch-all/unknown email results, require direct/mobile versus accept business main, run phone status checks, skip personalization — rather than provider jargon. Toggles map to the same visible typed workflow steps the engine runs.

## 4. Provider setup

For each provider:

- Explain what it supplies.
- Link to account/key instructions.
- Accept credentials securely; never display them after entry.
- Test the connection without spending credits when possible.
- Show connected/missing/failed state.
- Explain likely charges.

The UI knows whether a required provider is connected without exposing its secret. Credentials stay in the user's installation in DIY mode and encrypted per workspace in managed mode; they are never exposed to the model.

## 5. Preview

Before approval, show:

- Expected lead count.
- Coverage limitations.
- Providers involved.
- Free steps versus paid steps.
- Estimated cost/credits.
- Record cap.
- Validation depth, including what "valid" means for the selected providers.
- Storage/attribution notices.
- Explicit approval button.

Approval issues the engine's scoped token. Changing the preset, overrides, record cap, or budget invalidates it and requires a new preview.

## 6. Progress

- Current stage.
- Sourced count.
- Duplicates.
- Qualified count.
- Enrichment success/failure.
- Credits spent.
- Paused, retry, and manual-review states.
- Cancel action.

## 7. Results

Show per lead:

- Business/person.
- Website and location.
- Public business phone versus direct/mobile phone, with contact role.
- Validation status and last-checked time.
- Email status.
- Fit score and reason.
- Source and evidence.
- Suppression state.
- Review state.

Support:

- Filtering and selection.
- Review updates.
- Export.
- Continuing only selected leads into deeper enrichment.

## Milestone placement

- **Milestone 2**: bare-bones UI over the fake provider and existing application services; the full loop works without the CLI or an LLM harness.
- **Milestones 3–5**: the same screens gain real providers, presets, and contact-validation detail as those milestones land; no separate UI rebuild.
- **Milestone 6**: extend for hosted/managed use — authentication, per-workspace encrypted credentials, usage/spending limits, and managed-beta onboarding.

## Guardrails

- No spreadsheet formula engine.
- No node canvas.
- No connector marketplace.
- No analytics platform.
- No collaborative enterprise workspace.
- No arbitrary custom columns initially.
- A simple ordered-step editor may appear later under an Advanced option; it never permits arbitrary code.
