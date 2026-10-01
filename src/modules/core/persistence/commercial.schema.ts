import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { core, companies, customers, serviceCategories } from './masters.schema.js';
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
    paidAt: timestamp('paid_at', { withTimezone: true }),
    receiptId: uuid('receipt_id').references(() => receipts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_orders_provider_order_unique').on(t.provider, t.providerOrderId),
    uniqueIndex('payment_orders_provider_payment_unique').on(t.provider, t.providerPaymentId),
    index('payment_orders_milestone_idx').on(t.milestoneId, t.createdAt),
    check('payment_orders_amount_check', sql`${t.amount} > 0`),
    check(
      'payment_orders_status_check',
      sql`${t.status} IN ('CREATING','READY','PAID','EXPIRED','REVIEW_REQUIRED')`,
    ),
  ],
);
