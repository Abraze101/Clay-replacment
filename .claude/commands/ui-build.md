# UI Build

Read `CLAUDE.md`, `docs/product-requirements.md`, `docs/architecture.md`, `docs/workflows.md`, `docs/harness-compatibility.md`, `docs/ui-scope.md`, and `docs/implementation-plan.md`.

You own only the optional lightweight UI. The UI must call existing application services and may not duplicate workflow execution, provider logic, persistence, approval gates, enrichment rules, scoring, or exports.

Begin in plan mode. Inspect the implemented engine contract and propose:

1. The minimum routes, screens, and navigation.
2. Quick List, Call-Ready, and Full Enrichment controls.
3. Preview, paid-action approval, and run-progress behavior.
4. Lead results, contact validation, call readiness, and suppression presentation.
5. Mock-data, accessibility, responsive-layout, and integration-test strategy.
6. Exact files to create or change.

Do not implement until the plan is approved. If the required engine contract is not stable, produce a UI contract proposal and stop.
