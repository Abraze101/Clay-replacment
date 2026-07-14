# M5 vendor benchmarks (ADR-008 / ADR-009 / ADR-010)

All six capability adapters are BUILT (ADR-030); none is SELECTED. The owner
runs these benchmarks on their own keys, reviews the sanitized reports, and
records the final vendor decisions in the ADRs. CI never runs a benchmark —
the harnesses refuse under `CI` and refuse to spend without `--confirm`.

Common mechanics (`scripts/bench/shared.ts`):

- `--input <csv>` owner-supplied list, `--limit N` cap, `--probe` = 1 record.
- The worst-case spend estimate prints BEFORE `--confirm` is honored.
- Outputs: an UNSANITIZED working JSON in `./.data/bench/` (gitignored) and a
  SANITIZED markdown report (emails/phones masked) in `./exports/benchmarks/`,
  ready to paste into the ADR entry.

## 1. Contact discovery — ADR-008 (`pnpm bench:discovery`)

Candidates: BetterContact, FullEnrich (async submit-then-poll, ADR-029),
LeadMagic (sync). Whichever keys are present get benchmarked.

- **Input**: 25–50 person records exported from a real prior professional run:
  `first_name,last_name,company_name,company_domain[,linkedin_url]`.
- **Metrics**: work-email match rate, mobile/direct match rate, cross-vendor
  email agreement, ambiguity rate (submit crashes / lost jobs), error rate,
  submit→delivery latency p50/p95, vendor credits charged, credits per usable
  contact.
- **Spend**: worst case ≈ 11 credits/record/vendor (email 1 + phone 10);
  found-only billing usually lands far below. 25 records × 3 vendors ≈ $30–60.
- **Accuracy follow-up**: pipe the discovered emails through `bench:email`
  (`--verify` workflow) for a verified-valid rate per vendor.
- **Decision inputs the ADR needs**: match rate, accuracy, cost per usable
  result, latency, API reliability, poll behavior (job retention, lost-job
  rate), and whether the vendor echoes a client reference (BetterContact
  custom_fields / FullEnrich bulk name) — reconciliation quality matters as
  much as match rate.

## 2. Phone validation — ADR-009 (`pnpm bench:phone`)

Candidate: Twilio Lookup v2 (the sole built adapter; interface neutrality is
already proven by the shared capability contract tests running fake + Twilio
through identical assertions — a second live adapter, e.g. Telnyx, remains
the ADR's future-proofing note).

- **Input**: 25–50 numbers from a prior run export PLUS a small owner-known
  ground-truth set (own mobile, office landline, a VoIP number, a
  known-disconnected number): `phone[,expected_line_type][,expected_status][,business_name]`.
- **Metrics**: line-type accuracy on ground truth, line-status plausibility,
  CNAM business-match hit rate, ambiguity/error rate, latency, cost.
- **Spend**: ~2 signal packages ≈ $0.01 per lookup → under $2 for 50 numbers.

## 3. Email verification — ADR-010 (`pnpm bench:email`)

Candidates: ZeroBounce, MillionVerifier — the SAME list runs through both.

- **Input**: 25–50 emails mixing owner-known-good, fabricated-at-real-domains
  (known bad), role addresses (`info@`), a known catch-all domain, and
  discovered emails from benchmark 1: `email[,expected]`.
- **Metrics**: agreement matrix, accuracy on the known subset, unknown rate
  (both vendors refund unknowns, so it drives real cost), catch-all
  detection agreement, latency, credits charged.
- **Spend**: ~100 verifications ≈ $1–2 across both vendors.

## Recording the decision

Append to the matching ADR (008/009/010) in `docs/decisions.md`:

```
- **Benchmark (YYYY-MM-DD):** input set (n, provenance); metric table from
  exports/benchmarks/<name>-<date>.md; observed failure modes; benchmark cost.
- **Owner decision:** selected <vendor> because <reasons>. Runner-up notes.
- **Status:** accepted (was: pending)
```

Then select the vendor in `.env` (`CONTACT_DISCOVERY_PROVIDER=…`,
`PHONE_VALIDATION_PROVIDER=…`, `EMAIL_VERIFICATION_PROVIDER=…`) with its API
key. Adapter built ≠ vendor selected: the registry activates exactly what the
env selects (ADR-031).
