import { Type } from 'typebox';
import { idParamsSchema } from '../vendors/vendor.schemas.js';
import { tripSchema } from '../trips/trip.schemas.js';

export { idParamsSchema };

export const bookingStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('COMPLETED'),
  Type.Literal('CANCELLED'),
  Type.Literal('ARCHIVED'),
]);

const bookingFields = {
  bookingReference: Type.String({ minLength: 1, maxLength: 100 }),
  passengerName: Type.String({ minLength: 1, maxLength: 200 }),
  startsAt: Type.String({ format: 'date-time' }),
  endsAt: Type.String({ format: 'date-time' }),
  notes: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
};

export const createBookingBodySchema = Type.Object(
  {
    bookingReference: bookingFields.bookingReference,
    passengerName: bookingFields.passengerName,
    startsAt: bookingFields.startsAt,
    endsAt: bookingFields.endsAt,
    notes: Type.Optional(bookingFields.notes),
  },
  { additionalProperties: false },
);

export const updateBookingBodySchema = Type.Object(
  {
    bookingReference: Type.Optional(bookingFields.bookingReference),
    passengerName: Type.Optional(bookingFields.passengerName),
    startsAt: Type.Optional(bookingFields.startsAt),
    endsAt: Type.Optional(bookingFields.endsAt),
    notes: Type.Optional(bookingFields.notes),
    status: Type.Optional(
      Type.Union([Type.Literal('ACTIVE'), Type.Literal('COMPLETED'), Type.Literal('CANCELLED')]),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const bookingListQuerySchema = Type.Object({
  status: Type.Optional(bookingStatusSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});

export const bookingSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  bookingReference: Type.String(),
  passengerName: Type.String(),
  startsAt: Type.String({ format: 'date-time' }),
  endsAt: Type.String({ format: 'date-time' }),
  status: bookingStatusSchema,
  notes: Type.Union([Type.String(), Type.Null()]),
  tripCount: Type.Integer(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const bookingResponseSchema = Type.Object({ data: bookingSchema });
export const bookingDetailResponseSchema = Type.Object({
  data: Type.Object({ ...bookingSchema.properties, trips: Type.Array(tripSchema) }),
});
export const bookingListResponseSchema = Type.Object({
  data: Type.Array(bookingSchema),
  pagination: Type.Object({
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
  }),
});
