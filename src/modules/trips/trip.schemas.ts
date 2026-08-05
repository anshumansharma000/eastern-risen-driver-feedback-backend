import { Type } from 'typebox';
import { driverSourceSchema } from '../drivers/driver.schemas.js';
import { idParamsSchema } from '../vendors/vendor.schemas.js';

export { idParamsSchema };

export const tripCreationSourceSchema = Type.Union([
  Type.Literal('ADMIN_ASSIGNED'),
  Type.Literal('DRIVER_ENTERED'),
]);

export const tripStatusSchema = Type.Union([
  Type.Literal('READY'),
  Type.Literal('FEEDBACK_STARTED'),
  Type.Literal('SUBMITTED'),
  Type.Literal('ARCHIVED'),
]);

const tripFields = {
  bookingId: Type.String({ format: 'uuid' }),
  pickupLocation: Type.String({ minLength: 1, maxLength: 500 }),
  destination: Type.String({ minLength: 1, maxLength: 500 }),
  scheduledAt: Type.String({ format: 'date-time' }),
  scheduledEndAt: Type.String({ format: 'date-time' }),
  vehicleId: Type.String({ format: 'uuid' }),
};

export const createAdminTripBodySchema = Type.Object(
  { ...tripFields, driverId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

export const createDriverTripBodySchema = Type.Object(tripFields, { additionalProperties: false });

export const updateAdminTripBodySchema = Type.Object(
  {
    bookingId: Type.Optional(tripFields.bookingId),
    pickupLocation: Type.Optional(tripFields.pickupLocation),
    destination: Type.Optional(tripFields.destination),
    scheduledAt: Type.Optional(tripFields.scheduledAt),
    scheduledEndAt: Type.Optional(tripFields.scheduledEndAt),
    vehicleId: Type.Optional(tripFields.vehicleId),
    driverId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const tripListQuerySchema = Type.Object({
  status: Type.Optional(tripStatusSchema),
  driverId: Type.Optional(Type.String({ format: 'uuid' })),
  creationSource: Type.Optional(tripCreationSourceSchema),
  bookingId: Type.Optional(Type.String({ format: 'uuid' })),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});

export const driverTripListQuerySchema = Type.Object({
  status: Type.Optional(tripStatusSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});

export const tripSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  booking: Type.Object({
    id: Type.String({ format: 'uuid' }),
    bookingReference: Type.String(),
    passengerName: Type.String(),
  }),
  pickupLocation: Type.String(),
  destination: Type.String(),
  scheduledAt: Type.String({ format: 'date-time' }),
  scheduledEndAt: Type.String({ format: 'date-time' }),
  vehicle: Type.Object({
    id: Type.String({ format: 'uuid' }),
    registrationNumber: Type.String(),
    displayName: Type.String(),
  }),
  driver: Type.Object({
    id: Type.String({ format: 'uuid' }),
    displayName: Type.String(),
    driverCode: Type.String(),
    sourceType: driverSourceSchema,
    vendorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    vendorName: Type.Union([Type.String(), Type.Null()]),
  }),
  creationSource: tripCreationSourceSchema,
  status: tripStatusSchema,
  startedFeedbackAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const tripResponseSchema = Type.Object({ data: tripSchema });
export const tripListResponseSchema = Type.Object({
  data: Type.Array(tripSchema),
  pagination: Type.Object({
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
  }),
});
