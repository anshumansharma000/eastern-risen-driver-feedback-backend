import { Type } from 'typebox';

export const errorResponseSchema = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      details: Type.Optional(Type.Unknown()),
      requestId: Type.String(),
    }),
  },
  { $id: 'ErrorResponse' },
);

export const paginationSchema = Type.Object({
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1 }),
  total: Type.Integer({ minimum: 0 }),
});

export const paginationQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});
