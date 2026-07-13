import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveIdentity } from "../src/engine/dedupe/identity.js";
import { normalizeLinkedinUrl } from "../src/engine/records/normalize.js";
import { createWorkflowFromDefinition } from "../src/app/workflow-service.js";
import type { SourceProvider, SourceQuery, SourceRecord } from "../src/providers/types.js";
import { insertLead, setLeadIdentityKeys } from "../src/storage/repositories/lead-repo.js";
import { createTestApp, previewAndStart } from "./helpers/setup.js";

test("linkedin normalization: canonical person-profile key from approved-source URLs only", () => {
  const canonical = "linkedin.com/in/janesmith";
  assert.equal(normalizeLinkedinUrl("https://www.linkedin.com/in/janesmith"), canonical);
  assert.equal(normalizeLinkedinUrl("linkedin.com/in/JaneSmith/"), canonical);
  assert.equal(normalizeLinkedinUrl("https://uk.linkedin.com/in/janesmith?utm=x#top"), canonical);
  // Company pages are not person identity; other hosts are rejected outright.
  assert.equal(normalizeLinkedinUrl("https://www.linkedin.com/company/acme"), null);
  assert.equal(normalizeLinkedinUrl("https://notlinkedin.com/in/janesmith"), null);
  assert.equal(normalizeLinkedinUrl("https://evil.example/linkedin.com/in/x"), null);
  assert.equal(normalizeLinkedinUrl(""), null);
  assert.equal(normalizeLinkedinUrl(null), null);
});

test("identity: person ladder — apollo id matches unconditionally, linkedin needs a name match, business weak keys are skipped", async () => {
  const t = await createTestApp();
  const kysely = t.app.db.kysely;
  try {
    const jane = await insertLead(kysely, {
      agencyId: t.app.agencyId,
      kind: "person",
      displayName: "Jane Smith",
      sourceProvider: "apollo",
      sourceProviderId: "ap-1",
      apolloPersonId: "ap-1",
      normalizedLinkedinUrl: "linkedin.com/in/janesmith",
    });

    // 1. Same apollo person id → matched even under a different display name.
    assert.deepEqual(
      await resolveIdentity(kysely, {
        agencyId: t.app.agencyId,
        kind: "person",
        sourceProvider: "other-provider",
        sourceProviderId: "x-1",
        displayName: "J. Smith (Married Name)",
        normalizedDomain: null,
        normalizedPhone: null,
        locality: null,
        apolloPersonId: "ap-1",
        normalizedLinkedinUrl: null,
      }),
      { kind: "matched", leadId: jane.id, via: "apollo_person_id" },
    );

    // 2. Same linkedin + same normalized name → matched.
    assert.deepEqual(
      await resolveIdentity(kysely, {
        agencyId: t.app.agencyId,
        kind: "person",
        sourceProvider: "other-provider",
        sourceProviderId: "x-2",
        displayName: "  JANE Smith ",
        normalizedDomain: null,
        normalizedPhone: null,
        locality: null,
        apolloPersonId: null,
        normalizedLinkedinUrl: "linkedin.com/in/janesmith",
      }),
      { kind: "matched", leadId: jane.id, via: "linkedin" },
    );

    // 3. Same linkedin + DIFFERENT name → conflict, never a merge.
    const conflict = await resolveIdentity(kysely, {
      agencyId: t.app.agencyId,
      kind: "person",
      sourceProvider: "other-provider",
      sourceProviderId: "x-3",
      displayName: "Janet Smythe",
      normalizedDomain: null,
      normalizedPhone: null,
      locality: null,
      apolloPersonId: null,
      normalizedLinkedinUrl: "linkedin.com/in/janesmith",
    });
    assert.equal(conflict.kind, "conflict");
    assert.equal((conflict as { identifier: string }).identifier, "normalized_linkedin_url");

    // 4. Persons skip the business weak identifiers: sharing the employer's
    //    domain with an existing business lead is NOT a duplicate.
    await insertLead(kysely, {
      agencyId: t.app.agencyId,
      kind: "business",
      displayName: "Acme Health",
      normalizedDomain: "acmehealth.example",
      sourceProvider: "apollo",
      sourceProviderId: "org:org-1",
    });
    assert.deepEqual(
      await resolveIdentity(kysely, {
        agencyId: t.app.agencyId,
        kind: "person",
        sourceProvider: "apollo",
        sourceProviderId: "ap-9",
        displayName: "Acme Health", // even a name collision with the business
        normalizedDomain: "acmehealth.example",
        normalizedPhone: null,
        locality: null,
        apolloPersonId: null,
        normalizedLinkedinUrl: null,
      }),
      { kind: "new" },
    );
  } finally {
    await t.teardown();
  }
});

test("identity: setLeadIdentityKeys backfills only unheld keys; held keys flag a durable conflict", async () => {
  const t = await createTestApp();
  const kysely = t.app.db.kysely;
  try {
    const holder = await insertLead(kysely, {
      agencyId: t.app.agencyId,
      kind: "person",
      displayName: "Jane Smith",
      sourceProvider: "apollo",
      sourceProviderId: "ap-1",
      apolloPersonId: "ap-1",
    });
    const target = await insertLead(kysely, {
      agencyId: t.app.agencyId,
      kind: "person",
      displayName: "Different Person",
      sourceProvider: "imported-list",
      sourceProviderId: "import:x",
    });

    // apollo id already held by another lead → conflict row, column stays NULL;
    // the unheld linkedin key backfills normally.
    const result = await setLeadIdentityKeys(kysely, {
      leadId: target.id,
      agencyId: t.app.agencyId,
      keys: { apolloPersonId: "ap-1", normalizedLinkedinUrl: "linkedin.com/in/differentperson" },
    });
    assert.deepEqual(result.conflicts, ["apollo_person_id"]);

    const after = await kysely.selectFrom("leads").selectAll().where("id", "=", target.id).executeTakeFirstOrThrow();
    assert.equal(after.apollo_person_id, null);
    assert.equal(after.normalized_linkedin_url, "linkedin.com/in/differentperson");

    const conflicts = await kysely.selectFrom("identity_conflicts").selectAll().execute();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.identifier_type, "apollo_person_id");
    assert.equal(conflicts[0]?.status, "open");
    const pair = [conflicts[0]?.lead_id_a, conflicts[0]?.lead_id_b];
    assert.ok(pair.includes(holder.id) && pair.includes(target.id));
    assert.ok(String(conflicts[0]?.lead_id_a) < String(conflicts[0]?.lead_id_b), "pair is canonically ordered");

    // Replay is a no-op: same conflict, no duplicate row, still no backfill.
    await setLeadIdentityKeys(kysely, {
      leadId: target.id,
      agencyId: t.app.agencyId,
      keys: { apolloPersonId: "ap-1" },
    });
    assert.equal((await kysely.selectFrom("identity_conflicts").selectAll().execute()).length, 1);

    // An existing value on the lead itself is never overwritten.
    await setLeadIdentityKeys(kysely, {
      leadId: target.id,
      agencyId: t.app.agencyId,
      keys: { normalizedLinkedinUrl: "linkedin.com/in/somebody-else" },
    });
    const unchanged = await kysely.selectFrom("leads").selectAll().where("id", "=", target.id).executeTakeFirstOrThrow();
    assert.equal(unchanged.normalized_linkedin_url, "linkedin.com/in/differentperson");
  } finally {
    await t.teardown();
  }
});

/** Free stub source emitting person hits with employer blocks (no contact data — like Apollo search). */
class StubPeopleSource implements SourceProvider {
  readonly name = "stub-people";
  constructor(private readonly records: SourceRecord[]) {}
  search(query: SourceQuery): Promise<{ records: SourceRecord[]; requestId: string; coverageNote?: string }> {
    return Promise.resolve({
      records: this.records.slice(0, query.limit),
      requestId: "stub-people-1",
      coverageNote: "stubbed",
    });
  }
}

function personRecord(args: {
  key: string;
  name: string;
  first: string;
  last: string;
  linkedin?: string;
}): SourceRecord {
  return {
    sourceKey: args.key,
    name: args.name,
    kind: "person",
    title: "CEO",
    locality: "Austin",
    region: "TX",
    country: "US",
    ...(args.linkedin ? { linkedinUrl: args.linkedin } : {}),
    person: {
      firstName: args.first,
      lastName: args.last,
      apolloPersonId: args.key,
      employer: {
        name: "Acme Health",
        websiteUrl: "https://acmehealth.example",
        domain: "acmehealth.example",
        apolloOrganizationId: "org-1",
      },
    },
  };
}

test("dedupe run: person leads, one shared employer, linkedin conflict persisted and kept out of the pipeline", async () => {
  const t = await createTestApp();
  const kysely = t.app.db.kysely;
  try {
    const records = [
      personRecord({ key: "ap-1", name: "Jane Smith", first: "Jane", last: "Smith", linkedin: "https://www.linkedin.com/in/janesmith" }),
      // Different person claiming the SAME linkedin profile → conflict.
      personRecord({ key: "ap-2", name: "Janet Smythe", first: "Janet", last: "Smythe", linkedin: "https://www.linkedin.com/in/janesmith" }),
      personRecord({ key: "ap-3", name: "Bob Jones", first: "Bob", last: "Jones" }),
    ];
    t.app.providers.sources.set("stub-people", new StubPeopleSource(records));

    const definition = {
      id: "people-conflict-test",
      version: 1,
      name: "People conflict test",
      inputs: { limit: 10, enrichmentProfile: "quick_list" },
      steps: [
        { id: "discover", type: "source", provider: "stub-people" },
        { id: "normalize", type: "normalize" },
        { id: "dedupe", type: "dedupe" },
        { id: "review", type: "review_gate" },
        { id: "export", type: "export", format: "csv" },
      ],
    };
    const created = await createWorkflowFromDefinition(t.app, definition);
    const { run } = await previewAndStart(t.app, created.slug);
    const runRow = await kysely.selectFrom("runs").selectAll().where("id", "=", run.id).executeTakeFirstOrThrow();
    assert.equal(runRow.status, "waiting_review");

    const leads = await kysely.selectFrom("leads").selectAll().orderBy("created_at").execute();
    const businesses = leads.filter((l) => l.kind === "business");
    const persons = leads.filter((l) => l.kind === "person");
    // ONE shared employer lead; three person leads (the conflicted one still exists).
    assert.equal(businesses.length, 1);
    assert.equal(businesses[0]?.apollo_organization_id, "org-1");
    assert.equal(businesses[0]?.normalized_domain, "acmehealth.example");
    assert.equal(persons.length, 3);

    const jane = persons.find((p) => p.apollo_person_id === "ap-1");
    const janet = persons.find((p) => p.apollo_person_id === "ap-2");
    const bob = persons.find((p) => p.apollo_person_id === "ap-3");
    assert.ok(jane && janet && bob);
    // Every person hangs off the SAME employer lead; none carries its domain.
    for (const p of [jane, janet, bob]) {
      assert.equal(p.employer_lead_id, businesses[0]?.id);
      assert.equal(p.normalized_domain, null);
    }
    // The winner keeps the linkedin identity; the conflicted lead's column is NULL.
    assert.equal(jane.normalized_linkedin_url, "linkedin.com/in/janesmith");
    assert.equal(janet.normalized_linkedin_url, null);

    const conflicts = await kysely.selectFrom("identity_conflicts").selectAll().execute();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.identifier_type, "normalized_linkedin_url");
    assert.equal(conflicts[0]?.identifier_value, "linkedin.com/in/janesmith");
    assert.equal(conflicts[0]?.run_id, run.id);

    const items = await kysely.selectFrom("run_items").selectAll().where("run_id", "=", run.id).execute();
    const janetItem = items.find((i) => i.source_key === "ap-2");
    assert.equal(janetItem?.status, "skipped");
    assert.equal(janetItem?.skip_reason, "identity_conflict");
    assert.equal(janetItem?.dedupe_status, "conflict");
    assert.equal(janetItem?.lead_id, janet.id, "the conflicted lead is attached, not lost");
    for (const key of ["ap-1", "ap-3"]) {
      assert.equal(items.find((i) => i.source_key === key)?.status, "in_progress");
    }

    // Re-running the same workflow re-raises nothing new: the same open
    // conflict row remains, and no duplicate leads appear.
    const second = await previewAndStart(t.app, created.slug);
    const secondRow = await kysely.selectFrom("runs").selectAll().where("id", "=", second.run.id).executeTakeFirstOrThrow();
    assert.equal(secondRow.status, "waiting_review");
    assert.equal((await kysely.selectFrom("identity_conflicts").selectAll().execute()).length, 1);
    assert.equal((await kysely.selectFrom("leads").selectAll().execute()).length, 4);
  } finally {
    await t.teardown();
  }
});
