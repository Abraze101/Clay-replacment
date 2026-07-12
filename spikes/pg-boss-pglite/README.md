# pg-boss / PGlite compatibility spike

Milestone 0 deliverable mandated by `docs/proposals/consolidated-revision-directive.md` §13:
pg-boss's PGlite support (`fromPglite`) is new, so adoption waits on this bounded spike.
The outcome feeds **ADR-002** in `docs/decisions.md`.

Run (offline, writes only under `.data/spike-*`, cleans up after itself):

```text
pnpm spike:pgboss
```

Not part of `pnpm check`; it is a decision input, not a regression test.

## Scope and result (2026-07-11, pg-boss 12.25.1, @electric-sql/pglite 0.5.4, schema v36)

| # | Scenario | Result |
|---|---|---|
| 1 | `fromPglite` bootstrap: schema install + start on filesystem PGlite | PASS |
| 2 | Filesystem persistence across stop → close → reopen | PASS |
| 3 | Crashed-worker recovery (expiration + `supervise` → job retryable, never lost) | PASS |
| 4 | Retry with `retryLimit`, terminal `failed` state | PASS |
| 5 | Duplicate-claim prevention under concurrent fetches | PASS |
| 6 | Cancellation | PASS |
| 7 | Modest concurrency (20 jobs / 4 workers), exactly-once completion | PASS |
| 8 | Enqueue inside an application PGlite transaction via the per-call `db` override — rollback discards the job, commit keeps it | PASS |

## Findings and caveats

- PGlite is a single-connection database: pg-boss's concurrent fetches serialize
  through it (scenario 5 note: one fetch drained the batch). Correctness holds;
  parallel THROUGHPUT claims do not transfer from real Postgres.
- The spike drives maintenance explicitly (`supervise: false` + manual
  `supervise()` calls). A production deployment on real Postgres would leave the
  supervisor on; recovery latency then depends on `expireInSeconds` + the
  maintenance interval.
- pg-boss delivery is at-least-once. Job-delivery guarantees remain distinct
  from third-party paid-call side effects: the `run_item_steps` request-key
  ledger and per-adapter provider idempotency contract stay the credit-safety
  mechanism regardless of queue library.
- Decision per plan: pg-boss stays a devDependency in M0; the run executor
  remains the in-process claim-and-drain driver. The pg-boss driver lands
  behind the `JobQueue` interface at Milestone 1, now unblocked by this spike.
