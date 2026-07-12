/**
 * IANA timezone for a US state, but ONLY for states that lie wholly within a
 * single zone. Multi-zone states (TX, FL, TN, KY, IN, KS, NE, ND, SD, MI, ID,
 * OR, NV) and DST-irregular ones (AZ, HI, AK) are intentionally absent so the
 * engine never guesses — leads.timezone stays NULL and exports as unknown.
 */
const US_STATE_TIMEZONES: Record<string, string> = {
  // Eastern.
  CT: "America/New_York",
  DE: "America/New_York",
  GA: "America/New_York",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  NH: "America/New_York",
  NJ: "America/New_York",
  NY: "America/New_York",
  NC: "America/New_York",
  OH: "America/New_York",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  VT: "America/New_York",
  VA: "America/New_York",
  WV: "America/New_York",
  DC: "America/New_York",
  // Central.
  AL: "America/Chicago",
  AR: "America/Chicago",
  IL: "America/Chicago",
  IA: "America/Chicago",
  LA: "America/Chicago",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  OK: "America/Chicago",
  WI: "America/Chicago",
  // Mountain.
  CO: "America/Denver",
  MT: "America/Denver",
  NM: "America/Denver",
  UT: "America/Denver",
  WY: "America/Denver",
  // Pacific (only unambiguous states).
  CA: "America/Los_Angeles",
  WA: "America/Los_Angeles",
};

const US_COUNTRY_NAMES = new Set(["", "us", "usa", "united states", "united states of america"]);

export function usStateTimezone(region: string | null | undefined, country: string | null | undefined): string | null {
  if (!region) return null;
  const c = (country ?? "").trim().toLowerCase();
  if (!US_COUNTRY_NAMES.has(c)) return null;
  return US_STATE_TIMEZONES[region.trim().toUpperCase()] ?? null;
}
