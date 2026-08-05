import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authAccounts } from './accounts.js';
import { driverSourceType } from './enums.js';
import { vendors } from './vendors.js';

export const drivers = pgTable(
  'drivers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .unique()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    driverCode: text('driver_code').notNull(),
    phone: text('phone'),
    sourceType: driverSourceType('source_type').notNull(),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    assignmentEnabled: boolean('assignment_enabled').notNull().default(true),
    shiftStartTime: time('shift_start_time'),
    shiftEndTime: time('shift_end_time'),
    timeZone: text('time_zone').notNull().default('Asia/Kolkata'),
    maxDailyDutyMinutes: integer('max_daily_duty_minutes').notNull().default(720),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('drivers_code_unique').on(sql`lower(${table.driverCode})`),
    index('drivers_source_vendor_idx').on(table.sourceType, table.vendorId),
    check(
      'drivers_source_vendor_check',
      sql`(${table.sourceType} = 'OUTSOURCED' AND ${table.vendorId} IS NOT NULL)
          OR (${table.sourceType} = 'AGENCY' AND ${table.vendorId} IS NULL)`,
    ),
    check(
      'drivers_shift_pair_check',
      sql`(${table.shiftStartTime} IS NULL AND ${table.shiftEndTime} IS NULL)
          OR (${table.shiftStartTime} IS NOT NULL AND ${table.shiftEndTime} IS NOT NULL
              AND ${table.shiftStartTime} <> ${table.shiftEndTime})`,
    ),
    check(
      'drivers_max_daily_duty_minutes_check',
      sql`${table.maxDailyDutyMinutes} BETWEEN 1 AND 1440`,
    ),
  ],
);

export const driverLeavePeriods = pgTable(
  'driver_leave_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('driver_leave_periods_driver_time_idx').on(table.driverId, table.startsAt, table.endsAt),
    check('driver_leave_periods_range_check', sql`${table.endsAt} > ${table.startsAt}`),
  ],
);

export const driverLicenses = pgTable(
  'driver_licenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    driverId: uuid('driver_id')
      .notNull()
      .unique()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    licenseNumber: text('license_number'),
    issuedOn: date('issued_on'),
    expiresOn: date('expires_on'),
    issuingAuthority: text('issuing_authority'),
    categories: text('categories').array(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('driver_licenses_expiry_idx').on(table.expiresOn),
    check(
      'driver_licenses_date_range_check',
      sql`${table.issuedOn} IS NULL OR ${table.expiresOn} IS NULL OR ${table.expiresOn} > ${table.issuedOn}`,
    ),
  ],
);
