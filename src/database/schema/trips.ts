import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authAccounts } from './accounts.js';
import { bookings } from './bookings.js';
import { drivers } from './drivers.js';
import { driverSourceType, questionnairePurpose, tripCreationSource, tripStatus } from './enums.js';
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
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    pickupLocation: text('pickup_location').notNull(),
    destination: text('destination').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }).notNull(),
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
    index('trips_booking_scheduled_idx').on(table.bookingId, table.scheduledAt),
    index('trips_driver_status_scheduled_idx').on(table.driverId, table.status, table.scheduledAt),
    index('trips_status_scheduled_idx').on(table.status, table.scheduledAt),
    check('trips_schedule_range_check', sql`${table.scheduledEndAt} > ${table.scheduledAt}`),
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

export const tripFeedbackSections = pgTable(
  'trip_feedback_sections',
  {
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    purpose: questionnairePurpose('purpose').notNull(),
    assignedByAccountId: uuid('assigned_by_account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'trip_feedback_sections_trip_purpose_pk',
      columns: [table.tripId, table.purpose],
    }),
    index('trip_feedback_sections_booking_idx').on(table.bookingId),
    uniqueIndex('trip_feedback_sections_booking_boundary_unique')
      .on(table.bookingId, table.purpose)
      .where(sql`${table.purpose} IN ('ARRIVAL_EXPERIENCE', 'TOUR_EXPERIENCE')`),
  ],
);
