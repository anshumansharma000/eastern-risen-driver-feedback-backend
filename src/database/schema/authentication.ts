import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authAccounts } from './accounts.js';

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    previousTokenHash: text('previous_token_hash'),
    previousTokenValidUntil: timestamp('previous_token_valid_until', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_sessions_token_hash_unique').on(table.tokenHash),
    uniqueIndex('auth_sessions_previous_token_hash_unique').on(table.previousTokenHash),
    index('auth_sessions_account_expires_idx').on(table.accountId, table.expiresAt),
    index('auth_sessions_expiry_cleanup_idx').on(table.expiresAt),
    index('auth_sessions_absolute_expiry_idx').on(table.absoluteExpiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    requestedByAccountId: uuid('requested_by_account_id').references(() => authAccounts.id, {
      onDelete: 'restrict',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('password_reset_tokens_hash_unique').on(table.tokenHash),
    index('password_reset_tokens_account_idx').on(table.accountId, table.expiresAt),
  ],
);
