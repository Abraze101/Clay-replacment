# Claude Code handoff

Claude Code is the first implementation harness, not an architectural dependency. Harnesses are first beta interfaces, not the permanent interface. Read `docs/harness-compatibility.md`; everything built here must remain usable by Codex, OpenAI Agents SDK clients, and the Milestone 2 web UI through the same engine and application services.

## Before starting

1. Open this folder in a terminal.
2. Start Claude Code in plan mode.
3. Review the Apollo MCP server declared in `.mcp.json`.
4. Run `/mcp` only when you are ready to authenticate Apollo.
5. Do not paste API keys into chat; production keys belong in local environment/secret storage.

## First prompt: planning only

```text
Read CLAUDE.md and every referenced project document, then read all four
documents in docs/proposals/: consolidated-revision-directive.md,
milestone-0-plan.md, database-schema.md, and build-vs-adopt.md. Do not write
code yet.

We are starting Milestone 0 (engine skeleton) only. Inspect the workspace and
produce a file-level implementation plan, reconciled with
docs/proposals/milestone-0-plan.md, that includes:

- runtime and dependency choices with reasons;
- proposed project structure, including src/app/ application services;
- initial database tables and migration order;
- typed workflow schemas, the approved step allowlist, and immutable versioning;
- a fake provider, persistent fake run, preview/approval scope, CLI surface, and CSV export;
- the pg-boss/PGlite compatibility spike scope and pass criteria;
- local development setup on PGlite with no external services;
- lint, type-check, test, and build commands;
- fake fixture strategy;
- security and secret-handling boundaries;
- risks or conflicts with the documented architecture.

Keep all workflow, storage, job, provider, and CLI code independent from Claude.
Do not build the MCP transport, a web UI, or any model-provider integration in
Milestone 0.

Do not call Apollo, consume credits, authenticate external providers, or create
remote resources. Stop after the plan and wait for approval.
```

## Second prompt: implement the accepted skeleton

Use only after the Milestone 0 plan has been reviewed:

```text
Implement the accepted Milestone 0 plan only.

Preserve the boundaries and constraints in CLAUDE.md. Use fake data only. Do not
call external providers or create remote resources. Run the pg-boss/PGlite
compatibility spike and record its outcome as an ADR entry in docs/decisions.md.
Apply migrations locally, run lint, type checking, tests, and a production
build, then report:

1. Summary of changes.
2. Description of architecture and important decisions.
3. Exact validation results, including the fake workflow CLI flow and the spike outcome.
4. Setup commands and environment variables.
5. Remaining risks and the proposed Milestone 1 (harness adapter) plan.

Stop after Milestone 0.
```

## Milestone loop

For every later milestone:

1. Ask Claude for a plan restricted to that milestone.
2. Review external calls, migrations, destructive actions, and cost implications.
3. Approve the implementation scope.
4. Require validation and a completion report.
5. Record or update ADR entries in docs/decisions.md when a vendor/library decision is made or corrected.
6. Update the architecture docs when an accepted decision changes.
7. Commit only the reviewed milestone.

At Milestone 1, validate the same MCP tool contract from Claude Code, Codex, and
an OpenAI Agents SDK test client. Do not fork business logic by harness. At
Milestone 2, the minimal UI must call the same application services; do not fork
business logic by interface.

## Apollo MCP experiment prompt

Apollo MCP is for interactive prototyping and read-oriented verification only; production workflows use the typed REST adapter. Search first, inspect the sample, and stop before enrichment:

```text
Use the Apollo MCP server in a read-oriented way for this experiment.

Run one people or company search matching the campaign criteria I give you.
Show a small sample of results and the fields Apollo returned, then estimate
the credits that enriching this sample would consume. Stop before any
enrichment and wait for my approval.

Do not create contacts, enroll prospects in a sequence, send email, or write
to any CRM. Do not spend credits without my explicit approval.
```

After reviewing the estimate, approve at most five enriched records for the first experiment. Do not authorize contact creation, sequence enrollment, email sending, or CRM writes.

For local-business campaigns, use the local workflow design in `docs/workflows.md`; do not assume Apollo alone provides thorough coverage.

## Decisions that require the user

Claude must stop and ask before:

- Choosing a deployment platform or paid infrastructure.
- Choosing the Milestone 2 UI framework/stack.
- Spending Apollo credits beyond an already approved run budget.
- Enabling phone/personal-email waterfall enrichment.
- Selecting the contact-discovery waterfall vendor or email verifier after the Milestone 5 benchmark.
- Adopting a MiniMax account or keys, or any other embedded model-provider account.
- Adding any LinkedIn data source beyond Apollo-returned/imported URLs.
- Writing to HubSpot or another CRM.
- Sending messages or enrolling prospects in a sequence.
- Entering any managed-credit or data-resale arrangement.
- Adding billing, complex team roles, or enterprise/multi-tenant infrastructure beyond the minimal agency ownership boundary.
