import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authAccounts } from '../../database/schema/accounts.js';
import { customers } from '../core/persistence/masters.schema.js';

export const customerMemberships = pgTable(
  'customer_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    grantedBy: uuid('granted_by')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('customer_membership_unique').on(t.customerId, t.accountId),
    index('customer_membership_account_idx').on(t.accountId),
  ],
);

// Invitations never create an active login until the intended recipient activates it.
export const customerInvitations = pgTable(
  'customer_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('customer_invitation_customer_idx').on(t.customerId, t.createdAt),
    uniqueIndex('customer_pending_invitation_unique')
      .on(t.customerId, t.email)
      .where(sql`${t.consumedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  ],
);

export const customerRecoveryTokens = pgTable(
  'customer_recovery_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('customer_recovery_account_idx').on(t.accountId, t.createdAt),
    check('customer_recovery_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
