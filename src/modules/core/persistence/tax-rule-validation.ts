import { and, eq, isNull, lte, gte, ne, or } from 'drizzle-orm';
import type { CoreTransaction } from './database.js';
import { taxRules } from './masters.schema.js';
import type { TaxRulesInput } from '../http/masters.schemas.js';
import { conflict } from '../domain/errors.js';
/** Caller holds the tax configuration advisory lock for the whole write transaction. */
export async function ensureUnambiguousTaxRule(
  tx: CoreTransaction,
  input: TaxRulesInput,
  excludeId?: string,
): Promise<void> {
  if (input.status && input.status !== 'ACTIVE') return;
  const [overlap] = await tx
    .select({ id: taxRules.id })
    .from(taxRules)
    .where(
      and(
        eq(taxRules.status, 'ACTIVE'),
        eq(taxRules.component, input.component),
        input.serviceCategoryId
          ? eq(taxRules.serviceCategoryId, input.serviceCategoryId)
          : isNull(taxRules.serviceCategoryId),
        input.effectiveTo ? lte(taxRules.effectiveFrom, input.effectiveTo) : undefined,
        or(isNull(taxRules.effectiveTo), gte(taxRules.effectiveTo, input.effectiveFrom)),
        excludeId ? ne(taxRules.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  if (overlap)
    throw conflict(
      'TAX_RULE_OVERLAP',
      'An active tax rule already covers part of this period for the same component and service scope',
    );
}
