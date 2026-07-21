import { pgEnum } from 'drizzle-orm/pg-core';

export const accountRole = pgEnum('account_role', ['ADMIN', 'DRIVER']);
export const lifecycleStatus = pgEnum('lifecycle_status', [
  'ACTIVE',
  'DEACTIVATED',
  'ARCHIVED',
]);
export const driverSourceType = pgEnum('driver_source_type', ['AGENCY', 'OUTSOURCED']);
export const outboxStatus = pgEnum('outbox_status', [
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED',
]);
