import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { core, companies, customers, serviceCategories } from './masters.schema.js';
import type { QuotePricing, ProposedPlan } from '../application/commercial.contracts.js';
import type { ReviewReason, ResolutionInput } from '../application/payment-review.contracts.js';
import { invoices, receipts } from './billing.schema.js';

export const commercialBookings = core.table(
  'commercial_bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    serviceCategoryId: uuid('service_category_id')
      .notNull()
      .references(() => serviceCategories.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    serviceStartsOn: date('service_starts_on'),
    serviceEndsOn: date('service_ends_on'),
    status: text('status').notNull().default('DRAFT'),
    invoiceId: uuid('invoice_id')
      .unique()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    paymentActivation: jsonb('payment_activation').$type<{
      quoteId: string;
      requestHash: string;
    }>(),
    accessTokenHash: text('access_token_hash').unique(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('commercial_bookings_reference_unique').on(sql`lower(${t.reference})`),
    index('commercial_bookings_customer_idx').on(t.customerId, t.createdAt),
    check(
      'commercial_bookings_status_check',
      sql`${t.status} IN ('DRAFT','QUOTED','INVOICED','CONFIRMED','CANCELLED','COMPLETED')`,
    ),
    check(
      'commercial_bookings_dates_check',
      sql`${t.serviceEndsOn} IS NULL OR ${t.serviceStartsOn} IS NULL OR ${t.serviceEndsOn} >= ${t.serviceStartsOn}`,
    ),
  ],
);

export const commercialQuotes = core.table(
  'commercial_quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => commercialBookings.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    description: text('description').notNull(),
    inclusions: text('inclusions').notNull(),
    exclusions: text('exclusions').notNull(),
    terms: text('terms').notNull(),
    total: numeric('total', { precision: 18, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('INR'),
    pricing: jsonb('pricing').$type<QuotePricing>(),
    proposedPlan: jsonb('proposed_plan').$type<ProposedPlan>(),
    expiresOn: date('expires_on'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('commercial_quotes_booking_version_unique').on(t.bookingId, t.version),
    check('commercial_quotes_amount_check', sql`${t.total} > 0 AND ${t.currency} = 'INR'`),
  ],
);

export const paymentPolicies = core.table(
  'payment_policies',
  {
    companyId: uuid('company_id')
      .primaryKey()
      .references(() => companies.id, { onDelete: 'restrict' }),
    initialPercent: integer('initial_percent').notNull().default(30),
    balanceDaysBefore: integer('balance_days_before').notNull().default(30),
    fullPaymentWithinDays: integer('full_payment_within_days').notNull().default(30),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('payment_policies_percent_check', sql`${t.initialPercent} BETWEEN 1 AND 99`),
    check(
      'payment_policies_days_check',
      sql`${t.balanceDaysBefore} BETWEEN 1 AND 365 AND ${t.fullPaymentWithinDays} BETWEEN 0 AND 365`,
    ),
  ],
);

export const paymentMilestones = core.table(
  'payment_milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => commercialBookings.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    label: text('label').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    dueOn: date('due_on').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_milestones_booking_position_unique').on(t.bookingId, t.position),
    check('payment_milestones_amount_check', sql`${t.amount} > 0 AND ${t.position} > 0`),
  ],
);

export const paymentOrders = core.table(
  'payment_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => paymentMilestones.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    providerOrderId: text('provider_order_id').notNull(),
    sessionId: text('session_id'),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    status: text('status').notNull().default('CREATING'),
    providerPaymentId: text('provider_payment_id'),
    providerStatus: text('provider_status'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    snapshotStartedAt: timestamp('snapshot_started_at', { withTimezone: true }),
    reviewRequiredAt: timestamp('review_required_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    receiptId: uuid('receipt_id').references(() => receipts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_orders_provider_order_unique').on(t.provider, t.providerOrderId),
    uniqueIndex('payment_orders_provider_payment_unique').on(t.provider, t.providerPaymentId),
    index('payment_orders_milestone_idx').on(t.milestoneId, t.createdAt),
    index('payment_orders_receipt_idx').on(t.receiptId),
    check('payment_orders_amount_check', sql`${t.amount} > 0`),
    check(
      'payment_orders_status_check',
      sql`${t.status} IN ('CREATING','READY','PAID','EXPIRED','TERMINATED','REVIEW_REQUIRED','REFUNDED')`,
    ),
  ],
);

export const paymentAttempts = core.table(
  'payment_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => paymentOrders.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    providerPaymentId: text('provider_payment_id').notNull(),
    status: text('status').notNull(),
    rawStatus: text('raw_status').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    accountingStatus: text('accounting_status').notNull().default('UNAPPLIED'),
    reviewReasons: jsonb('review_reasons').$type<ReviewReason[]>().notNull().default([]),
    receiptId: uuid('receipt_id').references(() => receipts.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_attempts_provider_id_unique').on(t.provider, t.providerPaymentId),
    index('payment_attempts_order_idx').on(t.orderId, t.initiatedAt),
    index('payment_attempts_receipt_idx').on(t.receiptId),
    check(
      'payment_attempts_status_check',
      sql`${t.status} IN ('NOT_ATTEMPTED','PENDING','SUCCESS','FAILED','USER_DROPPED','CANCELLED','VOID','UNKNOWN')`,
    ),
    check(
      'payment_attempts_accounting_check',
      sql`${t.accountingStatus} IN ('UNAPPLIED','APPLIED','REVIEW_REQUIRED','REFUNDED')`,
    ),
    check('payment_attempts_amount_check', sql`${t.amount} >= 0`),
  ],
);

/** Append-only accounting decisions. Each attempt can have one terminal resolution. */
export const paymentAttemptResolutions = core.table(
  'payment_attempt_resolutions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => paymentAttempts.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => paymentOrders.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    actorId: uuid('actor_id').notNull(),
    note: text('note').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    receiptId: uuid('receipt_id').references(() => receipts.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    providerRefundReference: text('provider_refund_reference'),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    refund:
      jsonb('refund').$type<
        Extract<ResolutionInput, { action: 'RECORD_VERIFIED_EXTERNAL_REFUND' }>['refund']
      >(),
    before: jsonb('before').$type<Record<string, unknown>>().notNull(),
    after: jsonb('after').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_resolution_attempt_unique').on(t.attemptId),
    uniqueIndex('payment_resolution_idempotency_unique').on(t.idempotencyKey),
    uniqueIndex('payment_resolution_refund_unique').on(t.provider, t.providerRefundReference),
    index('payment_resolution_order_idx').on(t.orderId, t.createdAt),
    check(
      'payment_resolution_action_check',
      sql`${t.action} IN ('APPLY_TO_LINKED_INVOICE','LINK_EXISTING_RECEIPT','RECORD_VERIFIED_EXTERNAL_REFUND')`,
    ),
    check('payment_resolution_positive_check', sql`${t.amount} > 0`),
  ],
);

/** Durable work survives restarts. A lease token fences completion by an old worker. */
export const paymentReconciliationJobs = core.table(
  'payment_reconciliation_jobs',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => paymentOrders.id, { onDelete: 'restrict' }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(0),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payment_reconciliation_due_idx').on(t.nextCheckAt)],
);

/** Store only event identity, never the raw payload containing customer/payment details. */
export const paymentWebhookEvents = core.table(
  'payment_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    eventKey: text('event_key').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => paymentOrders.id, { onDelete: 'restrict' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_webhook_events_key_unique').on(t.provider, t.eventKey)],
);
