import { Type } from 'typebox';

export const principalSchema = Type.Object({
  accountId: Type.String({ format: 'uuid' }),
  role: Type.Union([Type.Literal('ADMIN'), Type.Literal('DRIVER')]),
  displayName: Type.String(),
  driverId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
});

export const adminLoginBodySchema = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 320 }),
    password: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const driverLoginBodySchema = Type.Object(
  {
    driverCode: Type.String({ minLength: 1, maxLength: 64 }),
    password: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const loginResponseSchema = Type.Object({
  data: Type.Object({
    user: principalSchema,
    expiresAt: Type.String({ format: 'date-time' }),
  }),
});

export const currentUserResponseSchema = Type.Object({ data: Type.Object({ user: principalSchema }) });
