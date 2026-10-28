import { Type, type Static, type TSchema } from 'typebox';
import { milestoneTypes, operationalStatuses } from '../../database/schema/timeline.js';
const uuid = Type.String({ format: 'uuid' });
const time = Type.String({ format: 'date-time' });
export const bookingParams = Type.Object({ bookingId: uuid });
export const pairParams = Type.Object({ bookingId: uuid, driverId: uuid });
export const idParams = Type.Object({ id: uuid });
export const paging = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  tripId: Type.Optional(uuid),
});
export const overviewQuery = Type.Object({
  page: paging.properties.page,
  pageSize: paging.properties.pageSize,
  bookingId: Type.Optional(uuid),
});
export const linkBody = Type.Object(
  { expiresAt: Type.Optional(time), regenerate: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
export const createEventBody = Type.Object(
  {
    clientEventId: uuid,
    tripId: uuid,
    assignmentVersion: Type.Integer({ minimum: 1 }),
    type: Type.Union(milestoneTypes.map((v) => Type.Literal(v))),
    occurredAt: time,
    recordedAt: time,
    submissionMode: Type.Union([Type.Literal('ONLINE'), Type.Literal('OFFLINE_SYNC')]),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    location: Type.Optional(
      Type.Object(
        {
          latitude: Type.Number({ minimum: -90, maximum: 90 }),
          longitude: Type.Number({ minimum: -180, maximum: 180 }),
          accuracyMeters: Type.Number({ minimum: 0, maximum: 100000 }),
          capturedAt: time,
        },
        { additionalProperties: false },
      ),
    ),
    photoIds: Type.Optional(Type.Array(uuid, { maxItems: 10, uniqueItems: true })),
    correctsEventId: Type.Optional(uuid),
    correctionReason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
  },
  { additionalProperties: false },
);
export type CreateEventBody = Static<typeof createEventBody>;
export const photoBody = Type.Object(
  {
    tripId: uuid,
    assignmentVersion: Type.Integer({ minimum: 1 }),
    contentType: Type.Union([
      Type.Literal('image/jpeg'),
      Type.Literal('image/png'),
      Type.Literal('image/webp'),
    ]),
    sizeBytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export const progressBody = Type.Object(
  {
    status: Type.Union(
      operationalStatuses.filter((s) => s !== 'UNKNOWN').map((s) => Type.Literal(s)),
    ),
    reason: Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }),
  },
  { additionalProperties: false },
);
// The service constructs safe projections; these envelopes preserve nullable dates and nested events.
export const receiptResponse = Type.Object({
  data: Type.Object({ id: uuid, receivedAt: time, replayed: Type.Boolean() }),
});

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const progressStatus = Type.String({ enum: [...operationalStatuses] });
const vehicle = Type.Object({ registrationNumber: Type.String(), displayName: Type.String() });
const pagination = Type.Object({
  page: Type.Integer(),
  pageSize: Type.Integer(),
  total: Type.Integer(),
});
export const linkResponse = Type.Object({
  data: Type.Object({
    id: uuid,
    bookingId: uuid,
    driverId: uuid,
    expiresAt: time,
    link: Type.String({ format: 'uri' }),
  }),
});
export const contextResponse = Type.Object({
  data: Type.Object({
    booking: Type.Object({
      id: uuid,
      bookingReference: Type.String(),
      passengerName: Type.String(),
      startsAt: time,
      endsAt: time,
      status: Type.String(),
    }),
    driverId: uuid,
    accessMethod: Type.String({ enum: ['LOGIN', 'LINK'] }),
    expiresAt: nullable(time),
    reportingClosesAt: time,
    trips: Type.Array(
      Type.Object({
        id: uuid,
        assignmentVersion: Type.Integer(),
        pickupLocation: Type.String(),
        destination: Type.String(),
        scheduledAt: time,
        scheduledEndAt: time,
        vehicle,
        operationalStatus: progressStatus,
        startedAt: nullable(time),
        completedAt: nullable(time),
      }),
    ),
  }),
});
export const eventsResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: uuid,
      clientEventId: uuid,
      bookingId: uuid,
      tripId: uuid,
      driverId: uuid,
      driverNameSnapshot: Type.String(),
      assignmentVersion: Type.Integer(),
      actorAccountId: nullable(uuid),
      linkId: nullable(uuid),
      type: Type.String({ enum: [...milestoneTypes] }),
      note: nullable(Type.String()),
      location: nullable(
        Type.Object({
          latitude: Type.Number(),
          longitude: Type.Number(),
          accuracyMeters: Type.Number(),
          capturedAt: time,
        }),
      ),
      occurredAt: time,
      recordedAt: time,
      receivedAt: time,
      submissionMode: Type.String({ enum: ['ONLINE', 'OFFLINE_SYNC'] }),
      correctsEventId: nullable(uuid),
      correctionReason: nullable(Type.String()),
      accessMethod: Type.String({ enum: ['LOGIN', 'LINK'] }),
      backdated: Type.Boolean(),
      photos: Type.Array(Type.Object({ id: uuid })),
    }),
  ),
  pagination,
});
export const bookingsResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: uuid,
      bookingReference: Type.String(),
      startsAt: time,
      endsAt: time,
      status: Type.String(),
    }),
  ),
  pagination,
});
export const overviewResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      tripId: uuid,
      bookingId: uuid,
      bookingReference: Type.String(),
      bookingStatus: Type.String(),
      driverId: uuid,
      driverName: Type.String(),
      assignmentVersion: Type.Integer(),
      scheduledAt: time,
      scheduledEndAt: time,
      pickupLocation: Type.String(),
      destination: Type.String(),
      operationalStatus: progressStatus,
      startedAt: nullable(time),
      completedAt: nullable(time),
      latestUpdate: nullable(Type.Record(Type.String(), Type.Unknown())),
      readyToClose: Type.Boolean(),
    }),
  ),
  pagination,
});
export const progressResponse = Type.Object({
  data: Type.Object({ tripId: uuid, status: progressStatus }),
});
export const photoUploadResponse = Type.Object({
  data: Type.Object({
    id: uuid,
    uploadUrl: Type.String(),
    method: Type.String(),
    headers: Type.Object({ 'Content-Type': Type.String() }),
    expiresAt: time,
    maxBytes: Type.Integer(),
  }),
});
export const photoCompleteResponse = Type.Object({
  data: Type.Object({ id: uuid, status: Type.String(), completedAt: nullable(time) }),
});
export const photoUrlResponse = Type.Object({
  data: Type.Object({ id: uuid, url: Type.String(), expiresAt: time }),
});
