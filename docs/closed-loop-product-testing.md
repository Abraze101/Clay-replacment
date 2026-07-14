# Closed-loop product testing

Status: future product-validation specification. This document does not approve a new implementation milestone, live provider calls, or provider spend.

## Purpose

The product needs one durable definition of a good result and a repeatable loop that can prove the engine, interfaces, providers, and final lead output work together.

The goal is not to maximize the number of fields returned. The goal is to produce the highest-value lead list per approved dollar while remaining honest about identity, source coverage, contact type, validation depth, uncertainty, and compliance status.

## North-star output

The optimal output is a **reviewed, evidence-backed, action-ready lead pack**. It contains useful leads that match the campaign, makes every important claim traceable, keeps unknowns visible, and can be handed to a human caller or operator without a cleanup project.

The lead pack has three parts.

### 1. Run summary

- Original user request and editable interpreted inputs.
- Immutable workflow version and resolved steps.
- Enrichment profile and overrides.
- Providers used and honest coverage limits.
- Approved record cap and budget.
- Estimated versus actual provider usage.
- Counts for sourced, duplicate, rejected, qualified, enriched, failed, and manual-review records.
- Warnings and unresolved exceptions.

### 2. Lead dataset

Every exported lead includes, when applicable:

- Stable business/person identity and the identifiers used to resolve it.
- Business name, domain, location, category, and relevant firmographic fields.
- Qualification result, deterministic score, and understandable reasons.
- Public business main phone kept separate from direct and mobile numbers.
- Exact phone checks performed, result, source, and checked-at time.
- Email discovery and verification states kept separate.
- Source provider, source URL or provider record ID, and retrieved-at time.
- Evidence supporting research, score explanations, and generated copy.
- Review state, call-readiness state, and suppression/compliance-review state.
- No unsupported claim represented as fact and no unknown status represented as cleared.

### 3. Exception report

- Rejected import rows.
- Duplicate and identity-conflict decisions.
- Missing or unavailable enrichment.
- Provider errors and rate-limit pauses.
- Ambiguous paid-call outcomes requiring manual review.
- Records excluded from the default export and the reason for exclusion.

Quick List, Call-Ready, and Full Enrichment are different depths of this same output contract. Quick List may legitimately omit person/contact enrichment. Call-Ready must make contact roles and validation depth explicit. Full Enrichment adds evidence-grounded research, scoring, and personalization; it does not weaken any honesty or approval requirement.

## Golden benchmark corpus

Create a versioned, human-reviewed benchmark corpus using sanitized data and frozen provider responses. Version 1 should contain about 100 records:

- 40 local/micro businesses.
- 30 professional/executive contacts.
- 30 imported-list rows.

The corpus must deliberately include ordinary successes and edge cases:

- Same business returned twice with different formatting.
- Similar names that must not be merged.
- Conflicting domains, phones, emails, and provider identifiers.
- A business with no website or Apollo match that remains a valid lead.
- Public business main, direct, mobile, VoIP, toll-free, invalid, and unknown phone cases.
- Valid, invalid, catch-all, unknown, role-based, and not-checked email cases.
- Suppressed records.
- Missing website research.
- Invalid generated output and unsupported-claim attempts.
- Rate limit, retryable failure, ambiguous paid outcome, crash, resume, cancel, and retry cases.
- CSV formula-injection and malformed-import cases.

Each benchmark record stores the expected identity, campaign-fit label, permitted contact classification, source evidence, expected workflow state, expected export decision, and the date/person responsible for the human label. Ground truth is versioned because businesses and contact data change.

## The four test loops

### Loop A: deterministic regression

Run on every change with fake providers and frozen fixtures. It proves workflow validation, plan resolution, approval binding, state transitions, persistence, dedupe, scoring, retry/idempotency behavior, review, suppression, and safe export. CI never uses live credentials or spends credits.

The same benchmark scenarios run through the CLI, MCP, and web API/UI adapters. The interfaces do not need byte-identical presentation, but they must resolve to the same application-service behavior, workflow plan, approval scope, durable state, and result semantics.

### Loop B: failure and recovery

Run before every release. Inject a crash or failure at each costly or stateful boundary and prove that:

- Completed work is not repeated.
- A possibly completed paid call is not automatically retried.
- Rate limits pause and resume correctly.
- Restarting or switching interfaces does not lose the run.
- Budget and record caps are never exceeded.
- Partial results and manual-review states remain usable and visible.

### Loop C: controlled live canary

Run manually after the relevant live provider is configured. It requires a visible preview and explicit approval, uses a small cap (normally 10–20 records), and records the approved budget. It is never part of CI.

Use one canary for each primary workflow family:

1. Local-business Quick List.
2. Selected-lead continuation into Call-Ready or Full Enrichment.
3. Professional/executive search with review before paid enrichment.
4. Imported-list normalization, dedupe, optional enrichment, and export.

Freeze a sanitized copy of useful live responses after secrets and prospect-sensitive fields are removed. A newly discovered failure becomes a deterministic fixture so it cannot silently return.

### Loop D: downstream usefulness

After a human actually reviews or works the list, feed outcome labels back into the evaluation dataset:

- Accepted or rejected lead, with reason.
- Correct or wrong business/person identity.
- Correct or wrong contact role.
- Connected, no answer, unreachable, or wrong number.
- Useful or unsupported research/personalization.
- Suppression/compliance issue.
- Export cleanup required.

This feedback is used to improve provider selection, workflow configuration, and deterministic scoring rules. It must not silently train the engine to bypass approval, invent missing data, or use an LLM as the sole qualification authority. Outreach remains human-controlled; the test system does not send messages or place calls.

## Initial release scorecard

The following are proposed starting gates. Quality targets can be tightened after baseline canaries, but safety invariants cannot be weakened.

### Zero-tolerance invariants

- 100% of paid actions require a valid, matching, unexpired approval token.
- 0 provider calls after changing the approved profile, capabilities, cap, budget, inputs, or plan hash without a new preview.
- 0 duplicate paid calls from retry or resume in deterministic/provider-contract tests.
- 0 automatic retries of ambiguous possibly-paid outcomes.
- 0 false identity merges in the benchmark corpus.
- 100% source provenance on exported rows.
- 100% exclusion of active suppressions from default callable exports.
- 0 public business numbers mislabeled as direct/mobile.
- 0 format-only phone checks labeled as fully verified.
- 0 unknown compliance states labeled as cleared.
- 0 unsupported generated claims accepted as fact.
- 0 secrets in logs, fixtures, prompts, MCP responses, screenshots, or exports.

### Functional gates

- 100% of golden workflow scenarios reach their expected terminal or pause/review state.
- 100% schema-valid result and export records.
- Restart/resume, cancel, retry, and cross-interface retrieval pass for every applicable scenario.
- Preview and actual spend reconcile without exceeding the approved budget.
- UI, CLI, and MCP produce equivalent semantic results from the same workflow and frozen provider inputs.

### Output-quality targets

- At least 90% of local-business candidates match the requested category and geography in the reviewed canary sample.
- At least 90% of professional candidates match requested title/seniority, employer, and geography criteria in the reviewed canary sample.
- Duplicate leakage below 2%; any false merge is a release blocker.
- At least 95% accuracy for contact role/classification on human-reviewed benchmark records.
- At least 95% of top-ranked rows have sufficient visible evidence for a human to understand why they qualified.
- At least 80% of the top-ranked exported rows are accepted by the human reviewer without manual data repair.

Live contactability and reply rates are monitored, not treated as pure engine correctness metrics, because they are also affected by the market, offer, timing, and human outreach. Wrong-number and identity-error rates are product-quality metrics and must be tracked separately from no-answer or no-reply outcomes.

## Closed-loop failure handling

Every failed assertion or human rejection is classified before changing the product:

1. Engine defect.
2. Interface-adapter defect.
3. Provider-data defect or drift.
4. Workflow/configuration defect.
5. Stale or incorrect benchmark label.
6. Expected coverage limitation.
7. Operator/compliance decision.

For each genuine defect:

1. Save the smallest sanitized reproducer.
2. Add or update the expected label.
3. Add an automated regression where possible.
4. Fix the correct layer without adding provider/model assumptions to the engine.
5. Rerun the affected scenario, then the full golden suite.
6. Record scorecard movement and any accepted residual risk.

## Definition of “the software works”

The product is ready for a beta declaration only when:

1. The deterministic golden suite and failure/recovery suite pass.
2. A nontechnical tester completes define -> preview -> approve -> run -> monitor -> review -> export through the UI without CLI or harness assistance.
3. CLI, MCP stdio, authenticated Streamable HTTP when deployed, and the UI demonstrate the same engine behavior.
4. At least three consecutive controlled live canary cycles meet the safety and functional gates and the agreed output-quality targets.
5. Every observed failure is fixed, represented by a regression, or explicitly accepted and documented as a coverage/risk limitation.

The benchmark corpus, evaluator, and live-canary runner should be implemented as a dedicated approved testing milestone. Until that milestone is approved, existing milestone work continues to use fixture-only CI and its documented acceptance criteria.
