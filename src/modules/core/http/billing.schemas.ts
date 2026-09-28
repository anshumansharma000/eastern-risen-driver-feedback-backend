import { Type } from 'typebox';
import {
  dateSchema,
  moneySchema,
  nonblank,
  optionalText,
  uuidSchema,
  versionSchema,
} from './masters.schemas.js';
export const componentSchema = Type.Union([
  Type.Literal('IGST'),
  Type.Literal('CGST'),
  Type.Literal('SGST'),
  Type.Literal('SERVICE_TAX'),
]);
export const taxTreatmentSchema = Type.Union([
  Type.Literal('TAXABLE'),
  Type.Literal('NON_TAXABLE'),
  Type.Literal('EXEMPT'),
  Type.Literal('NIL_RATED'),
]);
export const lineBody = Type.Object(
  {
    description: nonblank,
    amount: moneySchema,
    taxTreatment: taxTreatmentSchema,
    taxComponents: Type.Array(componentSchema, { maxItems: 4, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export const invoiceBody = Type.Object(
  {
    companyId: uuidSchema,
    customerId: uuidSchema,
    guestId: Type.Optional(Type.Union([uuidSchema, Type.Null()])),
    guestDisplayText: nonblank,
    passengerCount: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1, maximum: 100000 }), Type.Null()]),
    ),
    serviceCategoryId: uuidSchema,
    vehicleId: Type.Optional(Type.Union([uuidSchema, Type.Null()])),
    invoiceDate: dateSchema,
    dueDate: Type.Optional(Type.Union([dateSchema, Type.Null()])),
    serviceProvidedAt: nonblank,
    placeOfSupplyState: nonblank,
    placeOfSupplyCountry: nonblank,
    label: optionalText,
    bankAccountIds: Type.Array(uuidSchema, { maxItems: 10, uniqueItems: true }),
    lines: Type.Array(lineBody, { minItems: 1, maxItems: 200 }),
  },
  { additionalProperties: false },
);
export const invoiceUpdate = Type.Object(
  { ...invoiceBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const issueBody = Type.Object({ version: versionSchema }, { additionalProperties: false });
export const reasonBody = Type.Object({ reason: nonblank }, { additionalProperties: false });
export const paymentDetails = Type.Object(
  {
    reference: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    bankName: Type.Optional(nonblank),
    instrumentDate: Type.Optional(dateSchema),
    cardLastFour: Type.Optional(Type.String({ pattern: '^[0-9]{4}$' })),
  },
  { additionalProperties: false },
);
export const receiptBody = Type.Object(
  {
    invoiceId: uuidSchema,
    receivedDate: dateSchema,
    amount: moneySchema,
    method: Type.Union([
      Type.Literal('CASH'),
      Type.Literal('CHEQUE'),
      Type.Literal('DD'),
      Type.Literal('CARD'),
      Type.Literal('UPI'),
    ]),
    details: paymentDetails,
    status: Type.Union([Type.Literal('PENDING'), Type.Literal('CONFIRMED')]),
  },
  { additionalProperties: false },
);
export const adjustmentBody = Type.Object(
  { invoiceId: uuidSchema, amount: moneySchema, reason: nonblank, date: dateSchema },
  { additionalProperties: false },
);
export const idempotencyHeaders = Type.Object(
  { 'idempotency-key': Type.String({ pattern: '^[A-Za-z0-9_:-]{8,128}$' }) },
  { additionalProperties: true },
);
const nullableText = Type.Union([Type.String(), Type.Null()]);
const snapshotParty = Type.Object(
  { id: uuidSchema, name: Type.String() },
  { additionalProperties: true },
);
const invoiceSnapshot = Type.Object(
  {
    company: snapshotParty,
    customer: snapshotParty,
    guest: Type.Union([snapshotParty, Type.Null()]),
    serviceCategory: Type.Object(
      { id: uuidSchema, name: Type.String(), code: Type.String() },
      { additionalProperties: true },
    ),
    vehicle: Type.Union([
      Type.Object(
        {
          id: uuidSchema,
          name: Type.String(),
          registrationNumber: Type.String(),
          vehicleType: Type.String(),
        },
        { additionalProperties: true },
      ),
      Type.Null(),
    ]),
    bankAccounts: Type.Array(
      Type.Object(
        {
          id: uuidSchema,
          name: Type.String(),
          bankName: nullableText,
          accountNumber: Type.String(),
          branch: nullableText,
          ifscCode: nullableText,
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);
export const invoiceResponse = Type.Object({
  id: uuidSchema,
  companyId: uuidSchema,
  customerId: uuidSchema,
  guestId: nullableText,
  serviceCategoryId: uuidSchema,
  vehicleId: nullableText,
  invoiceDate: dateSchema,
  financialYear: nullableText,
  invoiceNumber: nullableText,
  status: Type.Union([Type.Literal('DRAFT'), Type.Literal('ISSUED'), Type.Literal('CANCELLED')]),
  version: versionSchema,
  details: Type.Object(
    {
      ...invoiceBody.properties,
      placeOfSupplyState: Type.Union([Type.String(), Type.Null()]),
      placeOfSupplyCountry: Type.Union([Type.String(), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  snapshot: Type.Union([invoiceSnapshot, Type.Null()]),
  subtotal: moneySchema,
  taxTotal: moneySchema,
  grandTotal: moneySchema,
  createdBy: uuidSchema,
  issuedAt: nullableText,
  cancelledAt: nullableText,
  cancellationReason: nullableText,
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export const receiptResponse = Type.Object({
  id: uuidSchema,
  invoiceId: uuidSchema,
  companyId: uuidSchema,
  receiptNumber: Type.String(),
  financialYear: Type.String(),
  receivedDate: dateSchema,
  amount: moneySchema,
  method: Type.String(),
  details: paymentDetails,
  status: Type.String(),
  createdBy: uuidSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  reversalReason: nullableText,
});
export const adjustmentResponse = Type.Object({
  id: uuidSchema,
  invoiceId: uuidSchema,
  amount: moneySchema,
  reason: Type.String(),
  date: dateSchema,
  createdBy: uuidSchema,
  createdAt: Type.String(),
  reversedAt: nullableText,
  reversalReason: nullableText,
});
export const invoiceDetailResponse = Type.Object({
  ...invoiceResponse.properties,
  guestDisplayText: Type.String(),
  passengerCount: Type.Union([Type.Integer(), Type.Null()]),
  dueDate: nullableText,
  serviceProvidedAt: Type.String(),
  placeOfSupplyState: nullableText,
  placeOfSupplyCountry: nullableText,
  label: nullableText,
  bankAccountIds: Type.Array(uuidSchema),
  lines: Type.Array(
    Type.Object({
      id: uuidSchema,
      invoiceId: uuidSchema,
      position: Type.Integer(),
      description: Type.String(),
      amount: moneySchema,
      taxTreatment: taxTreatmentSchema,
      taxAmount: moneySchema,
      total: moneySchema,
      taxes: Type.Array(
        Type.Object({
          id: uuidSchema,
          lineId: uuidSchema,
          ruleId: Type.Union([uuidSchema, Type.Null()]),
          component: componentSchema,
          rate: Type.String(),
          amount: moneySchema,
        }),
      ),
      appliedTaxes: Type.Array(
        Type.Object({
          id: uuidSchema,
          lineId: uuidSchema,
          ruleId: Type.Union([uuidSchema, Type.Null()]),
          component: componentSchema,
          rate: Type.String(),
          amount: moneySchema,
        }),
      ),
    }),
  ),
  receivedAmount: moneySchema,
  adjustmentAmount: moneySchema,
  dueAmount: moneySchema,
  paymentStatus: Type.String(),
  receipts: Type.Array(receiptResponse),
  adjustments: Type.Array(adjustmentResponse),
});
