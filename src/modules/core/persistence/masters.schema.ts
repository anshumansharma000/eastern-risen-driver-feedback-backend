import { sql } from 'drizzle-orm';
import {
  check,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
export const core = pgSchema('core');
export const masterStatus = core.enum('master_status', ['ACTIVE', 'INACTIVE', 'ARCHIVED']);
export const customerCategory = core.enum('customer_category', ['AGENT', 'LEISURE', 'CORPORATE']);
export const marketType = core.enum('market_type', ['DOMESTIC', 'INTERNATIONAL']);
export const hotelPlan = core.enum('hotel_plan', ['APAI', 'MAPAI', 'CPAI']);
export const taxComponent = core.enum('tax_component', ['IGST', 'CGST', 'SGST', 'SERVICE_TAX']);
const metadata = () => ({
  id: uuid('id').primaryKey().defaultRandom(),
  status: masterStatus('status').notNull().default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const companies = core.table(
  'companies',
  {
    ...metadata(),
    name: text('name').notNull(),
    address: text('address'),
    phone: text('phone'),
    mobileNumber: text('mobile_number'),
    email: text('email'),
    pan: text('pan'),
    serviceTaxNumber: text('service_tax_number'),
    cin: text('cin'),
    gstNumber: text('gst_number'),
    website: text('website'),
    state: text('state'),
    country: text('country'),
    postalCode: text('postal_code'),
    branchOffice: text('branch_office'),
    paymentInstructions: text('payment_instructions'),
    footerNotes: text('footer_notes'),
  },
  (t) => [index('companies_name_idx').on(t.name, t.id)],
);
export const bankAccounts = core.table(
  'bank_accounts',
  {
    ...metadata(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    bankName: text('bank_name'),
    accountNumber: text('account_number').notNull(),
    branch: text('branch'),
    ifscCode: text('ifsc_code'),
    swiftCode: text('swift_code'),
  },
  (t) => [index('bank_accounts_name_idx').on(t.name, t.id)],
);
export const customers = core.table(
  'customers',
  {
    ...metadata(),
    name: text('name').notNull(),
    category: customerCategory('category').notNull(),
    address: text('address'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    postalCode: text('postal_code'),
    phone: text('phone'),
    mobileNumber: text('mobile_number'),
    email: text('email'),
    contactPerson: text('contact_person'),
    pan: text('pan'),
    serviceTaxNumber: text('service_tax_number'),
    gstNumber: text('gst_number'),
    market: marketType('market'),
  },
  (t) => [index('customers_name_idx').on(t.name, t.id)],
);
export const guests = core.table(
  'guests',
  {
    ...metadata(),
    name: text('name').notNull(),
    address: text('address'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    postalCode: text('postal_code'),
    phone: text('phone'),
    mobileNumber: text('mobile_number'),
    email: text('email'),
    contactPerson: text('contact_person'),
    market: marketType('market'),
    legacyLastServiceAvailed: text('legacy_last_service_availed'),
    legacyLastAmountPaid: numeric('legacy_last_amount_paid', { precision: 18, scale: 2 }),
  },
  (t) => [index('guests_name_idx').on(t.name, t.id)],
);
export const hotels = core.table(
  'hotels',
  {
    ...metadata(),
    name: text('name').notNull(),
    address: text('address'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    postalCode: text('postal_code'),
    phone: text('phone'),
    mobileNumber: text('mobile_number'),
    email: text('email'),
    contactPerson: text('contact_person'),
    market: marketType('market'),
  },
  (t) => [index('hotels_name_idx').on(t.name, t.id)],
);
export const hotelRates = core.table(
  'hotel_rates',
  {
    ...metadata(),
    hotelId: uuid('hotel_id')
      .notNull()
      .references(() => hotels.id, { onDelete: 'restrict' }),
    plan: hotelPlan('plan').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('INR'),
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),
    name: text('name').notNull(),
  },
  (t) => [
    index('hotel_rates_name_idx').on(t.name, t.id),
    check(
      'hotel_rates_period',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    check('hotel_rate_nonnegative', sql`${t.amount} >= 0`),
  ],
);
export const serviceCategories = core.table(
  'service_categories',
  {
    ...metadata(),
    name: text('name').notNull(),
    code: text('code').notNull(),
    requiresVehicle: boolean('requires_vehicle').notNull().default(false),
  },
  (t) => [index('service_categories_name_idx').on(t.name, t.id)],
);
export const taxRules = core.table(
  'tax_rules',
  {
    ...metadata(),
    name: text('name').notNull(),
    component: taxComponent('component').notNull(),
    serviceCategoryId: uuid('service_category_id').references(() => serviceCategories.id, {
      onDelete: 'restrict',
    }),
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
  },
  (t) => [
    index('tax_rules_name_idx').on(t.name, t.id),
    check('tax_rate_range', sql`${t.rate} >= 0 AND ${t.rate} <= 100`),
    check(
      'tax_rules_period',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);
export const vendorProfiles = core.table(
  'vendor_profiles',
  {
    ...metadata(),
    vendorId: uuid('vendor_id').notNull(),
    address: text('address'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    postalCode: text('postal_code'),
    mobileNumber: text('mobile_number'),
    market: marketType('market'),
  },
  (t) => [uniqueIndex('vendor_profile_vendor_unique').on(t.vendorId)],
);
// External identity IDs deliberately have no foreign keys into another module.
export const coreAuditEvents = core.table(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('core_audit_entity_idx').on(t.entityId, t.createdAt),
    index('core_audit_created_idx').on(t.createdAt),
    index('core_audit_actor_created_idx').on(t.actorId, t.createdAt),
  ],
);
export const coreOutbox = core.table(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, string>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    index('core_outbox_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);
// One legacy record can map to a consolidated entity without losing either source identity.
export const legacyMappings = core.table(
  'legacy_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    sourceTable: text('source_table').notNull(),
    sourceId: text('source_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    rawRecord: jsonb('raw_record').$type<Record<string, unknown>>().notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('legacy_source_unique').on(t.source, t.sourceTable, t.sourceId)],
);
