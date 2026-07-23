import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authAccounts } from './accounts.js';
import { drivers } from './drivers.js';
import { driverSourceType, tripCreationSource, tripStatus } from './enums.js';
import { vehicles } from './vehicles.js';
import { vendors } from './vendors.js';

export interface VehicleSnapshot {
  readonly registrationNumber: string;
  readonly displayName: string;
}

export const trips = pgTable(
  'trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingReference: text('booking_reference').notNull(),
    passengerName: text('passenger_name').notNull(),
    pickupLocation: text('pickup_location').notNull(),
    destination: text('destination').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    vehicleSnapshot: jsonb('vehicle_snapshot').$type<VehicleSnapshot>().notNull(),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'restrict' }),
    driverNameSnapshot: text('driver_name_snapshot').notNull(),
    driverCodeSnapshot: text('driver_code_snapshot').notNull(),
    driverSourceSnapshot: driverSourceType('driver_source_snapshot').notNull(),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    vendorNameSnapshot: text('vendor_name_snapshot'),
    creationSource: tripCreationSource('creation_source').notNull(),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    status: tripStatus('status').notNull().default('READY'),
    startedFeedbackAt: timestamp('started_feedback_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('trips_booking_reference_idx').on(table.bookingReference),
    index('trips_driver_status_scheduled_idx').on(table.driverId, table.status, table.scheduledAt),
    index('trips_status_scheduled_idx').on(table.status, table.scheduledAt),
    check(
      'trips_vendor_snapshot_check',
      sql`(${table.driverSourceSnapshot} = 'OUTSOURCED'
            AND ${table.vendorId} IS NOT NULL
            AND ${table.vendorNameSnapshot} IS NOT NULL)
          OR (${table.driverSourceSnapshot} = 'AGENCY'
            AND ${table.vendorId} IS NULL
            AND ${table.vendorNameSnapshot} IS NULL)`,
    ),
    check(
      'trips_archived_at_check',
      sql`(${table.status} = 'ARCHIVED' AND ${table.archivedAt} IS NOT NULL)
          OR (${table.status} <> 'ARCHIVED' AND ${table.archivedAt} IS NULL)`,
    ),
  ],
);
