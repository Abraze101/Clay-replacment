# Core Build

Read `CLAUDE.md`, `AGENTS.md`, and every document imported by `CLAUDE.md` before acting.

You own implementation of the headless lead engine. Work on exactly one milestone from `docs/implementation-plan.md` at a time.

For the current milestone:

1. Inspect the repository and all uncommitted changes.
2. State assumptions, touched files, migrations, tests, and external calls.
3. Produce a file-level plan before editing.
4. Stop and wait for approval before implementation.

Preserve the provider-neutral engine, CLI/MCP adapter boundary, approval gates, enrichment semantics, and fake-fixture testing rules. Do not begin the optional UI and do not call live providers unless the user explicitly approves the relevant later milestone and its budget.

Begin with Milestone 0. Codex started package/config scaffolding but did not implement application modules; audit those uncommitted files rather than assuming they are correct.
