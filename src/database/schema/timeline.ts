// Feedback-product persistence only. No core tables or core lifecycle dependencies.
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  check,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { bookings } from './bookings.js';
import { trips } from './trips.js';
import { drivers } from './drivers.js';
import { authAccounts } from './accounts.js';

export const operationalStatuses = [
  'UNKNOWN',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type OperationalStatus = (typeof operationalStatuses)[number];
export const milestoneTypes = [
  'TRIP_STARTED',
  'PASSENGER_PICKED_UP',
  'ARRIVED',
  'DROPPED_OFF',
  'TRIP_COMPLETED',
  'NOTE',
  'DELAY',
  'CORRECTION',
] as const;
export type MilestoneType = (typeof milestoneTypes)[number];
export interface EventLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
}

export const timelineProgress = pgTable(
  'feedback_trip_progress',
  {
    tripId: uuid('trip_id')
      .primaryKey()
      .references(() => trips.id, { onDelete: 'cascade' }),
    status: text('status').$type<OperationalStatus>().notNull().default('UNKNOWN'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'feedback_trip_progress_status_check',
      sql`${t.status} in ('UNKNOWN','SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED')`,
    ),
  ],
);

export const driverBookingLinks = pgTable(
  'feedback_driver_booking_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    tokenCiphertext: text('token_ciphertext').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdByAccountId: uuid('created_by_account_id')
      .notNull()
      .references(() => authAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('feedback_driver_booking_links_token_unique').on(t.tokenHash),
    index('feedback_driver_booking_links_pair_idx').on(t.bookingId, t.driverId),
  ],
);

// A grant never silently follows a later reassignment, even if the original driver returns.
export const driverLinkTrips = pgTable(
  'feedback_driver_link_trips',
  {
    linkId: uuid('link_id')
      .notNull()
      .references(() => driverBookingLinks.id, { onDelete: 'cascade' }),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'restrict' }),
    assignmentVersion: integer('assignment_version').notNull(),
  },
  (t) => [primaryKey({ columns: [t.linkId, t.tripId] })],
);

export const timelineEvents = pgTable(
  'feedback_timeline_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientEventId: uuid('client_event_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'restrict' }),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'restrict' }),
    driverNameSnapshot: text('driver_name_snapshot').notNull(),
    assignmentVersion: integer('assignment_version').notNull(),
    actorAccountId: uuid('actor_account_id').references(() => authAccounts.id, {
      onDelete: 'restrict',
    }),
    linkId: uuid('link_id').references(() => driverBookingLinks.id, { onDelete: 'restrict' }),
    type: text('type').$type<MilestoneType>().notNull(),
    note: text('note'),
    location: jsonb('location').$type<EventLocation>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    submissionMode: text('submission_mode').$type<'ONLINE' | 'OFFLINE_SYNC'>().notNull(),
    correctsEventId: uuid('corrects_event_id').references((): AnyPgColumn => timelineEvents.id, {
      onDelete: 'restrict',
    }),
    correctionReason: text('correction_reason'),
  },
  (t) => [
    uniqueIndex('feedback_timeline_events_client_unique').on(t.clientEventId),
    index('feedback_timeline_events_booking_time_idx').on(t.bookingId, t.occurredAt, t.receivedAt),
    index('feedback_timeline_events_trip_idx').on(t.tripId),
    check(
      'feedback_timeline_events_submission_check',
      sql`${t.submissionMode} in ('ONLINE','OFFLINE_SYNC')`,
    ),
    check(
      'feedback_timeline_events_type_check',
      sql`${t.type} in ('TRIP_STARTED','PASSENGER_PICKED_UP','ARRIVED','DROPPED_OFF','TRIP_COMPLETED','NOTE','DELAY','CORRECTION')`,
    ),
    check(
      'feedback_timeline_events_actor_check',
      sql`(${t.actorAccountId} is not null and ${t.linkId} is null) or (${t.actorAccountId} is null and ${t.linkId} is not null)`,
    ),
    check(
      'feedback_timeline_events_correction_check',
      sql`(${t.type} = 'CORRECTION' and ${t.correctsEventId} is not null and ${t.correctionReason} is not null) or (${t.type} <> 'CORRECTION' and ${t.correctsEventId} is null and ${t.correctionReason} is null)`,
    ),
  ],
);

export const timelinePhotos = pgTable(
  'feedback_timeline_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'restrict' }),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'restrict' }),
    assignmentVersion: integer('assignment_version').notNull(),
    eventId: uuid('event_id').references(() => timelineEvents.id, { onDelete: 'restrict' }),
    uploadObjectKey: text('upload_object_key').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').$type<'image/jpeg' | 'image/png' | 'image/webp'>().notNull(),
    status: text('status')
      .$type<'PENDING' | 'READY' | 'ATTACHED' | 'REJECTED'>()
      .notNull()
      .default('PENDING'),
    byteSize: integer('byte_size'),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }).notNull(),
    temporaryObjectCleanedAt: timestamp('temporary_object_cleaned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('feedback_timeline_photos_upload_key_unique').on(t.uploadObjectKey),
    uniqueIndex('feedback_timeline_photos_stored_key_unique').on(t.objectKey),
    index('feedback_timeline_photos_event_idx').on(t.eventId),
    index('feedback_timeline_photos_cleanup_idx').on(t.createdAt, t.status),
    check(
      'feedback_timeline_photos_state_check',
      sql`(${t.status} in ('PENDING','REJECTED') and ${t.eventId} is null) or (${t.status} = 'READY' and ${t.completedAt} is not null and ${t.eventId} is null) or (${t.status} = 'ATTACHED' and ${t.completedAt} is not null and ${t.eventId} is not null)`,
    ),
  ],
);
