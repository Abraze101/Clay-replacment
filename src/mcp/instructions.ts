/**
 * Server initialization instructions. Codex reads only a prefix while
 * selecting tools, so the essential rules MUST sit inside the first 512
 * characters (verified by test/mcp-contract.test.ts).
 */
export const SERVER_INSTRUCTIONS = `RULES: (1) run_preview first — it returns the plan, costs, and a single-use approval token. (2) A human must approve before run_start; run_start and run_resume require that token. Missing, expired, consumed, or scope-changed tokens are rejected with APPROVAL_* codes; changing profile, overrides, cap, or budget needs a new preview. (3) Paid enrichment: max 100 records per run; runs pause at the credit limit. (4) No outbound actions: never send email, enroll contacts, or write to a CRM.

Lead-engine workflow tools. Typical flow: workflow_create (or workflow_list) -> run_preview -> human approval -> run_start -> run_status -> lead_review_update -> run_resume -> run_results -> run_export_csv. Runs are durable: they continue in the engine when the conversation closes, and any client can read them later via run_status/run_results. run_results is paginated (cursor/limit, default 50). Results use the envelope {ok, data, summary, warnings, requestId, nextActions}; errors carry machine-readable codes in error.code, never stack traces. This milestone ships fake providers only — no real provider credits can be spent — but the approval gate behaves exactly as it will with live providers.`;
