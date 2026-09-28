import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { core, companies, customers, guests, serviceCategories } from './masters.schema.js';
import type {
  InvoiceInput,
  InvoiceSnapshot,
  PaymentDetails,
} from '../application/billing.contracts.js';
import type { AppliedTax, TaxTreatment } from '../domain/billing.js';
export const invoiceStatus = core.enum('invoice_status', ['DRAFT', 'ISSUED', 'CANCELLED']);
export const receiptStatus = core.enum('receipt_status', ['PENDING', 'CONFIRMED', 'REVERSED']);
export const paymentMethod = core.enum('payment_method', ['CASH', 'CHEQUE', 'DD', 'CARD', 'UPI']);
export const invoices = core.table(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    guestId: uuid('guest_id').references(() => guests.id, { onDelete: 'restrict' }),
    serviceCategoryId: uuid('service_category_id')
      .notNull()
      .references(() => serviceCategories.id, { onDelete: 'restrict' }),
    // Shared-catalog identity: deliberately no cross-module foreign key.
    vehicleId: uuid('vehicle_id'),
    invoiceDate: date('invoice_date').notNull(),
    financialYear: text('financial_year'),
    invoiceNumber: text('invoice_number'),
    status: invoiceStatus('status').notNull().default('DRAFT'),
    version: integer('version').notNull().default(1),
    details: jsonb('details').$type<InvoiceInput>().notNull(),
    snapshot: jsonb('snapshot').$type<InvoiceSnapshot>(),
    subtotal: numeric('subtotal', { precision: 18, scale: 2 }).notNull(),
    taxTotal: numeric('tax_total', { precision: 18, scale: 2 }).notNull(),
    grandTotal: numeric('grand_total', { precision: 18, scale: 2 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invoice_number_unique').on(t.companyId, t.financialYear, t.invoiceNumber),
    index('invoices_customer_date_idx').on(t.customerId, t.invoiceDate),
    index('invoices_company_date_idx').on(t.companyId, t.invoiceDate),
    index('invoices_status_date_idx').on(t.status, t.invoiceDate),
    index('invoices_service_category_date_idx').on(t.serviceCategoryId, t.invoiceDate),
    index('invoices_vehicle_date_idx').on(t.vehicleId, t.invoiceDate),
    check(
      'invoice_number_state',
      sql`(${t.status} = 'DRAFT' AND ${t.invoiceNumber} IS NULL AND ${t.snapshot} IS NOT NULL AND ${t.issuedAt} IS NULL) OR (${t.status} <> 'DRAFT' AND ${t.invoiceNumber} IS NOT NULL AND ${t.snapshot} IS NOT NULL AND ${t.issuedAt} IS NOT NULL)`,
    ),
    check(
      'invoice_totals_check',
      sql`${t.subtotal} >= 0 AND ${t.taxTotal} >= 0 AND ${t.grandTotal} = ${t.subtotal} + ${t.taxTotal}`,
    ),
  ],
);
export const invoiceLines = core.table(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    description: text('description').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    taxTreatment: text('tax_treatment').$type<TaxTreatment>().notNull(),
    taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }).notNull(),
    total: numeric('total', { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex('invoice_line_position_unique').on(t.invoiceId, t.position),
    check(
      'line_amount_check',
      sql`${t.position} > 0 AND ${t.amount} >= 0 AND ${t.taxAmount} >= 0 AND ${t.total} = ${t.amount} + ${t.taxAmount}`,
    ),
  ],
);
export const invoiceLineTaxes = core.table(
  'invoice_line_taxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lineId: uuid('line_id')
      .notNull()
      .references(() => invoiceLines.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id'),
    component: text('component').$type<AppliedTax['component']>().notNull(),
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex('line_component_unique').on(t.lineId, t.component),
    index('line_taxes_component_rate_idx').on(t.component, t.rate),
    check('line_tax_nonnegative', sql`${t.rate} >= 0 AND ${t.rate} <= 100 AND ${t.amount} >= 0`),
  ],
);
export const documentCounters = core.table(
  'document_counters',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    financialYear: text('financial_year').notNull(),
    kind: text('kind').notNull(),
    value: integer('value').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.financialYear, t.kind] }),
    check('counter_range', sql`${t.value} BETWEEN 1 AND 999999`),
  ],
);
export const receipts = core.table(
  'receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    receiptNumber: text('receipt_number').notNull(),
    financialYear: text('financial_year').notNull(),
    receivedDate: date('received_date').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    method: paymentMethod('method').notNull(),
    details: jsonb('details').$type<PaymentDetails>().notNull(),
    status: receiptStatus('status').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    reversalReason: text('reversal_reason'),
  },
  (t) => [
    uniqueIndex('receipt_idempotency_unique').on(t.idempotencyKey),
    uniqueIndex('receipt_number_unique').on(t.companyId, t.financialYear, t.receiptNumber),
    index('receipts_invoice_idx').on(t.invoiceId),
    index('receipts_status_date_idx').on(t.status, t.receivedDate),
    index('receipts_method_date_idx').on(t.method, t.receivedDate),
    check('receipt_positive', sql`${t.amount} > 0`),
  ],
);
export const settlementAdjustments = core.table(
  'settlement_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    reason: text('reason').notNull(),
    date: date('date').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdBy: uuid('created_by').notNull(),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('adjustment_idempotency_unique').on(t.idempotencyKey),
    index('adjustments_invoice_idx').on(t.invoiceId),
    index('adjustments_date_idx').on(t.date),
    index('adjustments_active_date_idx')
      .on(t.date)
      .where(sql`${t.reversedAt} is null`),
    check('adjustment_positive', sql`${t.amount} > 0`),
  ],
);
