import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, parseImportCsv } from "../src/engine/import/csv-import.js";
import { importSourceKey } from "../src/providers/imported/source.js";
import { AppError } from "../src/shared/errors.js";

function fixture(name: string): string {
  return readFileSync(path.resolve("test/fixtures/imported", name), "utf8");
}

test("csv import: clean file — alias headers map, all rows accepted", () => {
  const result = parseImportCsv(fixture("contacts-clean.csv"));
  assert.equal(result.rows.length, 8);
  assert.equal(result.rejectedCount, 0);
  assert.deepEqual(result.warnings, []);

  const acme = result.rows[0]!;
  assert.equal(acme.name, "Acme Roof Sample Co");
  assert.equal(acme.website, "https://acmeroof.example");
  assert.equal(acme.email, "owner@acmeroof.example");
  assert.equal(acme.linkedinUrl, "https://www.linkedin.com/in/sanitized-owner-one");
  assert.equal(acme.contactName, "Pat Sample");
  assert.equal(acme.title, "Owner");
  assert.equal(acme.locality, "Austin");
  assert.equal(acme.region, "TX");

  // Single-identifier rows survive: domain-only and email-only are usable.
  assert.ok(result.rows.some((r) => r.website === "domainonly.example" && !r.email));
  assert.ok(result.rows.some((r) => r.email === "solo@emailonly.example" && !r.website));
});

test("csv import: messy file — BOM + case-insensitive aliases work; bad rows reject individually", () => {
  const result = parseImportCsv(fixture("contacts-messy.csv"));
  assert.equal(result.rows.length, 4, "two duplicate-domain rows, the cleaned linkedin row, the final row");
  assert.equal(result.rejectedCount, 2, "the all-empty row and the phone-only row lack identifiers");
  assert.ok(result.rejected.every((r) => /identifier/.test(r.reason)));
  assert.ok(result.rejected.every((r) => r.line >= 2), "line numbers are 1-based after the header");
  assert.ok(result.warnings.some((w) => /non-LinkedIn value/.test(w)), "off-domain linkedin dropped with a warning");
  assert.ok(result.warnings.some((w) => /Accepted 4 of 6/.test(w)));

  const badLinkedin = result.rows.find((r) => r.name === "Bad Linkedin Row");
  assert.ok(badLinkedin);
  assert.equal(badLinkedin.linkedinUrl, undefined, "the non-LinkedIn value never enters the row");
  assert.equal(badLinkedin.contactName, "Riley Sample");
});

test("csv import: structural problems fail the whole file with machine-readable details", () => {
  // Unknown header — named, never silently dropped.
  assert.throws(
    () => parseImportCsv(fixture("contacts-bad-header.csv")),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === "VALIDATION_FAILED" &&
      (err.details["unknownHeaders"] as string[]).includes("Favorite Color"),
  );
  // Inconsistent column count — carries the line.
  assert.throws(
    () => parseImportCsv("company,website\nAcme,https://acme.example,EXTRA\n"),
    (err: unknown) => err instanceof AppError && /parsed|Invalid/i.test(err.message),
  );
  // Too many rows.
  const big = ["company"].concat(Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_u, i) => `Company ${i}`)).join("\n");
  assert.throws(
    () => parseImportCsv(big),
    (err: unknown) => err instanceof AppError && err.details["maxRows"] === IMPORT_MAX_ROWS,
  );
  // Oversized text.
  const huge = `company\n${"x".repeat(IMPORT_MAX_BYTES)}\n`;
  assert.throws(
    () => parseImportCsv(huge),
    (err: unknown) => err instanceof AppError && err.details["maxBytes"] === IMPORT_MAX_BYTES,
  );
  // Zero accepted rows.
  assert.throws(
    () => parseImportCsv("phone\n512-555-0100\n"),
    (err: unknown) => err instanceof AppError && /no usable rows/.test(err.message),
  );
});

test("csv import: sourceKey precedence and stability", () => {
  // Precedence: domain → linkedin → email → phone → name hash.
  assert.match(
    importSourceKey({ name: "X", website: "https://www.acme.example/about", email: "a@b.example" }),
    /^import:domain:acme\.example:[0-9a-f]{8}$/,
  );
  assert.equal(importSourceKey({ website: "https://www.acme.example/about" }), "import:domain:acme.example");
  // Same domain + different names stay distinct (dedupe flags them instead of
  // a silent merge); same domain + same name collapses.
  const nameA = importSourceKey({ name: "Location A", website: "https://shared.example" });
  const nameB = importSourceKey({ name: "Location B", website: "https://shared.example" });
  assert.notEqual(nameA, nameB);
  assert.equal(nameA, importSourceKey({ name: "  location -- a ", website: "https://shared.example" }));
  assert.equal(
    importSourceKey({ name: "X", linkedinUrl: "https://www.linkedin.com/in/Someone-Sample/", email: "a@b.example" }),
    "import:li:someone-sample",
  );
  assert.equal(importSourceKey({ name: "X", email: "Mixed.Case@B.example" }), "import:email:mixed.case@b.example");
  assert.equal(importSourceKey({ name: "X", phone: "(512) 555-0100" }), "import:phone:+15125550100");
  const byName = importSourceKey({ name: "  Acme -- Roofing  " });
  assert.equal(byName, importSourceKey({ name: "acme roofing" }), "name hash uses the normalized name key");
  assert.match(byName, /^import:name:[0-9a-f]{16}$/);

  // Same parsed row → same key across parses (idempotent re-import).
  const a = parseImportCsv(fixture("contacts-clean.csv")).rows.map(importSourceKey);
  const b = parseImportCsv(fixture("contacts-clean.csv")).rows.map(importSourceKey);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length, "clean fixture rows have distinct identities");
});
