import { AppError } from "../shared/errors.js";
import type { SuppressionScope } from "../storage/database-types.js";
import type { SuppressionRow } from "../storage/repositories/suppression-repo.js";
import { addSuppression, listSuppressions, releaseSuppression } from "../storage/repositories/suppression-repo.js";
import { normalizeDomain, normalizeEmail, normalizePhone } from "../engine/records/normalize.js";
import type { AppContainer } from "./container.js";

/**
 * Entity-specific do-not-contact management (M5). Values are normalized here
 * so the stored form always matches what call-readiness and export-time
 * evaluation compare against (E.164 / lowercase email / registrable domain /
 * lead uuid). Applied before every call-ready export; releasing requires an
 * explicit operator action and is an UPDATE, never a DELETE.
 */
export async function suppress(
  app: AppContainer,
  input: { scope: SuppressionScope; value: string; reason: string },
): Promise<SuppressionRow> {
  const normalizedValue = normalizeSuppressionValue(input.scope, input.value);
  return await addSuppression(app.db.kysely, {
    agencyId: app.agencyId,
    scope: input.scope,
    normalizedValue,
    reason: input.reason,
    requestedBy: app.actor,
  });
}

export async function releaseSuppressionById(app: AppContainer, id: string): Promise<boolean> {
  return await releaseSuppression(app.db.kysely, { id, agencyId: app.agencyId, releasedBy: app.actor });
}

export async function listActiveSuppressions(
  app: AppContainer,
  opts: { scope?: SuppressionScope; includeReleased?: boolean } = {},
): Promise<SuppressionRow[]> {
  return await listSuppressions(app.db.kysely, app.agencyId, opts);
}

export function normalizeSuppressionValue(scope: SuppressionScope, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new AppError("VALIDATION_FAILED", "Suppression value must not be empty.", {});
  switch (scope) {
    case "phone": {
      const parsed = normalizePhone(trimmed);
      if (!parsed?.e164) {
        throw new AppError("VALIDATION_FAILED", `'${trimmed}' is not a parseable phone number.`, {});
      }
      return parsed.e164;
    }
    case "email": {
      const email = normalizeEmail(trimmed);
      if (!email) throw new AppError("VALIDATION_FAILED", `'${trimmed}' is not a valid email address.`, {});
      return email;
    }
    case "domain": {
      const domain = normalizeDomain(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
      if (!domain) throw new AppError("VALIDATION_FAILED", `'${trimmed}' is not a registrable domain.`, {});
      return domain;
    }
    case "lead": {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        throw new AppError("VALIDATION_FAILED", "Lead-scope suppression takes a lead id (uuid).", {});
      }
      return trimmed.toLowerCase();
    }
  }
}
