import { Type } from 'typebox';

export const lifecycleStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('DEACTIVATED'),
  Type.Literal('ARCHIVED'),
]);

export const vendorSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  contactName: Type.Union([Type.String(), Type.Null()]),
  contactEmail: Type.Union([Type.String(), Type.Null()]),
  contactPhone: Type.Union([Type.String(), Type.Null()]),
  status: lifecycleStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const createVendorBodySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    contactName: Type.Optional(Type.String({ maxLength: 200 })),
    contactEmail: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
    contactPhone: Type.Optional(Type.String({ maxLength: 32 })),
  },
  { additionalProperties: false },
);

export const updateVendorBodySchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    contactName: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    contactEmail: Type.Optional(
      Type.Union([Type.String({ format: 'email', maxLength: 320 }), Type.Null()]),
    ),
    contactPhone: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const listQuerySchema = Type.Object({
  status: Type.Optional(lifecycleStatusSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});

export const statusBodySchema = Type.Object(
  { status: lifecycleStatusSchema },
  { additionalProperties: false },
);

export const idParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) });
