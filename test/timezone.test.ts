import assert from "node:assert/strict";
import { test } from "node:test";

import { usStateTimezone } from "../src/engine/records/timezone.js";

test("timezone: single-zone US states map; multi-zone and non-US never guess", () => {
  assert.equal(usStateTimezone("CO", "United States"), "America/Denver");
  assert.equal(usStateTimezone("GA", "United States"), "America/New_York");
  assert.equal(usStateTimezone("ca", "US"), "America/Los_Angeles");
  // Country may be absent when the address parse could not extract it.
  assert.equal(usStateTimezone("NY", null), "America/New_York");

  // Multi-zone / DST-irregular states are intentionally absent.
  assert.equal(usStateTimezone("TX", "United States"), null);
  assert.equal(usStateTimezone("FL", "United States"), null);
  assert.equal(usStateTimezone("AZ", "United States"), null);

  // Non-US and empty region never map.
  assert.equal(usStateTimezone("ON", "Canada"), null);
  assert.equal(usStateTimezone(null, "United States"), null);
});
