import type { CoreTransaction } from './database.js';
import { coreAuditEvents } from './masters.schema.js';
export async function audit(
  tx: CoreTransaction,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  await tx.insert(coreAuditEvents).values({ actorId, action, entityType, entityId });
}
