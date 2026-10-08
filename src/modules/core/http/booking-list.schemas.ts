import { Type, type Static } from 'typebox';
import { querySchema, uuidSchema, dateSchema } from './masters.schemas.js';
export const bookingListQuery = Type.Object(
  {
    ...Type.Omit(querySchema, ['status']).properties,
    status: Type.Optional(
      Type.Union(
        ['DRAFT', 'QUOTED', 'INVOICED', 'CONFIRMED', 'CANCELLED', 'COMPLETED'].map((value) =>
          Type.Literal(value),
        ),
      ),
    ),
    companyId: Type.Optional(uuidSchema),
    customerId: Type.Optional(uuidSchema),
    serviceStartsFrom: Type.Optional(dateSchema),
    serviceStartsTo: Type.Optional(dateSchema),
    quoteAcceptance: Type.Optional(
      Type.Union([
        Type.Literal('NONE'),
        Type.Literal('AWAITING_ACCEPTANCE'),
        Type.Literal('ACCEPTED'),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type BookingListQuery = Static<typeof bookingListQuery>;

const nullableText = Type.Union([Type.String(), Type.Null()]);
export const bookingListEnvelope = Type.Object({
  data: Type.Array(
    Type.Object({
      id: uuidSchema,
      reference: Type.String(),
      companyId: uuidSchema,
      customerId: uuidSchema,
      serviceCategoryId: uuidSchema,
      title: Type.String(),
      serviceStartsOn: nullableText,
      serviceEndsOn: nullableText,
      status: Type.String(),
      invoiceId: Type.Union([uuidSchema, Type.Null()]),
      paymentActivation: Type.Union([
        Type.Object({ quoteId: uuidSchema, requestHash: Type.String() }),
        Type.Null(),
      ]),
      createdBy: uuidSchema,
      createdAt: Type.String(),
      updatedAt: Type.String(),
      customerName: nullableText,
      latestQuoteVersion: Type.Union([Type.Integer(), Type.Null()]),
      latestQuoteAcceptedAt: nullableText,
      invoiceNumber: nullableText,
      receivedAmount: nullableText,
      dueAmount: nullableText,
    }),
  ),
  pagination: Type.Object({
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
  }),
});

export type BookingListRow = Static<typeof bookingListEnvelope>['data'][number];
