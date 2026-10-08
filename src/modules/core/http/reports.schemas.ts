import { Type, type Static } from 'typebox';
import { dateSchema, uuidSchema } from './masters.schemas.js';

const customerCategory = Type.Union([
  Type.Literal('AGENT'),
  Type.Literal('LEISURE'),
  Type.Literal('CORPORATE'),
]);
const invoiceStatus = Type.Union([
  Type.Literal('DRAFT'),
  Type.Literal('ISSUED'),
  Type.Literal('CANCELLED'),
]);
const sortOrder = Type.Union([Type.Literal('asc'), Type.Literal('desc')]);
const page = Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 }));
const pageSize = Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }));
const common = {
  from: Type.Optional(dateSchema),
  to: Type.Optional(dateSchema),
  companyId: Type.Optional(uuidSchema),
  customerId: Type.Optional(uuidSchema),
  customerCategory: Type.Optional(customerCategory),
  serviceCategoryId: Type.Optional(uuidSchema),
  vehicleId: Type.Optional(uuidSchema),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  sortOrder: Type.Optional(sortOrder),
  page,
  pageSize,
};

export const dashboardQuery = Type.Object(
  {
    from: Type.Optional(dateSchema),
    to: Type.Optional(dateSchema),
    companyId: Type.Optional(uuidSchema),
    customerCategory: Type.Optional(customerCategory),
    serviceCategoryId: Type.Optional(uuidSchema),
  },
  { additionalProperties: false },
);

export const invoiceReportQuery = Type.Object(
  {
    ...common,
    status: Type.Optional(invoiceStatus),
    paymentStatus: Type.Optional(
      Type.Union([
        Type.Literal('NOT_APPLICABLE'),
        Type.Literal('UNPAID'),
        Type.Literal('PARTIALLY_PAID'),
        Type.Literal('PAID'),
      ]),
    ),
    financialYear: Type.Optional(Type.String({ pattern: '^[0-9]{4}$' })),
    hasVehicle: Type.Optional(Type.Boolean()),
    sortBy: Type.Optional(
      Type.Union([
        Type.Literal('invoiceDate'),
        Type.Literal('invoiceNumber'),
        Type.Literal('customer'),
        Type.Literal('customerCategory'),
        Type.Literal('serviceCategory'),
        Type.Literal('vehicle'),
        Type.Literal('status'),
        Type.Literal('subtotal'),
        Type.Literal('taxTotal'),
        Type.Literal('grandTotal'),
        Type.Literal('receivedAmount'),
        Type.Literal('adjustmentAmount'),
        Type.Literal('dueAmount'),
        Type.Literal('dueDate'),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const vehicleInvoiceReportQuery = Type.Object(
  {
    ...common,
    status: Type.Optional(invoiceStatus),
    includeUnassigned: Type.Optional(Type.Boolean()),
    sortBy: Type.Optional(
      Type.Union([
        Type.Literal('registrationNumber'),
        Type.Literal('vehicleName'),
        Type.Literal('vehicleType'),
        Type.Literal('invoiceCount'),
        Type.Literal('grandTotal'),
        Type.Literal('receivedAmount'),
        Type.Literal('dueAmount'),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const taxReportQuery = Type.Object(
  {
    ...common,
    status: Type.Optional(invoiceStatus),
    component: Type.Optional(
      Type.Union([
        Type.Literal('IGST'),
        Type.Literal('CGST'),
        Type.Literal('SGST'),
        Type.Literal('SERVICE_TAX'),
      ]),
    ),
    rate: Type.Optional(Type.String({ pattern: '^(100(\\.0{1,4})?|[0-9]{1,2}(\\.[0-9]{1,4})?)$' })),
    sortBy: Type.Optional(
      Type.Union([
        Type.Literal('component'),
        Type.Literal('rate'),
        Type.Literal('serviceCategory'),
        Type.Literal('taxableBase'),
        Type.Literal('taxAmount'),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const paymentReportQuery = Type.Object(
  {
    ...common,
    status: Type.Optional(
      Type.Union([Type.Literal('PENDING'), Type.Literal('CONFIRMED'), Type.Literal('REVERSED')]),
    ),
    method: Type.Optional(
      Type.Union([
        Type.Literal('CASH'),
        Type.Literal('CHEQUE'),
        Type.Literal('DD'),
        Type.Literal('CARD'),
        Type.Literal('UPI'),
        Type.Literal('GATEWAY'),
      ]),
    ),
    sortBy: Type.Optional(
      Type.Union([
        Type.Literal('receivedDate'),
        Type.Literal('receiptNumber'),
        Type.Literal('amount'),
        Type.Literal('method'),
        Type.Literal('status'),
        Type.Literal('invoiceNumber'),
        Type.Literal('customer'),
        Type.Literal('createdAt'),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const unifiedPaymentReportQuery = Type.Object(
  {
    from: common.from,
    to: common.to,
    companyId: common.companyId,
    customerId: common.customerId,
    customerCategory: common.customerCategory,
    serviceCategoryId: common.serviceCategoryId,
    q: common.q,
    sortOrder: common.sortOrder,
    page,
    pageSize,
    source: Type.Optional(Type.Union([Type.Literal('MANUAL'), Type.Literal('GATEWAY')])),
    needsReview: Type.Optional(Type.Boolean()),
    receiptStatus: paymentReportQuery.properties.status,
    method: paymentReportQuery.properties.method,
    gatewayStatus: Type.Optional(
      Type.Union([
        Type.Literal('CREATING'),
        Type.Literal('READY'),
        Type.Literal('PAID'),
        Type.Literal('EXPIRED'),
        Type.Literal('TERMINATED'),
        Type.Literal('REVIEW_REQUIRED'),
        Type.Literal('REFUNDED'),
      ]),
    ),
    sortBy: Type.Optional(
      Type.Union([
        Type.Literal('activityAt'),
        Type.Literal('createdAt'),
        Type.Literal('receivedDate'),
        Type.Literal('paidAt'),
        Type.Literal('amount'),
        Type.Literal('source'),
        Type.Literal('method'),
        Type.Literal('receiptStatus'),
        Type.Literal('gatewayStatus'),
        Type.Literal('receiptNumber'),
        Type.Literal('providerOrderId'),
        Type.Literal('invoiceNumber'),
        Type.Literal('bookingReference'),
        Type.Literal('customer'),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const receivablesReportQuery = Type.Object(
  {
    ...common,
    paymentStatus: Type.Optional(
      Type.Union([Type.Literal('UNPAID'), Type.Literal('PARTIALLY_PAID'), Type.Literal('PAID')]),
    ),
    ageingBucket: Type.Optional(
      Type.Union([
        Type.Literal('NOT_DUE'),
        Type.Literal('1_30'),
        Type.Literal('31_60'),
        Type.Literal('61_90'),
        Type.Literal('90_PLUS'),
        Type.Literal('NO_DUE_DATE'),
      ]),
    ),
    overdueOnly: Type.Optional(Type.Boolean()),
    dueFrom: Type.Optional(dateSchema),
    dueTo: Type.Optional(dateSchema),
    sortBy: Type.Optional(
      Type.Union([
        Type.Literal('invoiceDate'),
        Type.Literal('dueDate'),
        Type.Literal('daysOverdue'),
        Type.Literal('invoiceNumber'),
        Type.Literal('customer'),
        Type.Literal('customerCategory'),
        Type.Literal('serviceCategory'),
        Type.Literal('vehicle'),
        Type.Literal('grandTotal'),
        Type.Literal('receivedAmount'),
        Type.Literal('adjustmentAmount'),
        Type.Literal('dueAmount'),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const discountReportQuery = Type.Object(
  {
    ...common,
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('REVERSED')])),
    creatorId: Type.Optional(uuidSchema),
    sortBy: Type.Optional(
      Type.Union([
        Type.Literal('date'),
        Type.Literal('amount'),
        Type.Literal('invoiceNumber'),
        Type.Literal('customer'),
        Type.Literal('customerCategory'),
        Type.Literal('creator'),
        Type.Literal('reversedAt'),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const customerStatementQuery = Type.Object(
  {
    from: Type.Optional(dateSchema),
    to: Type.Optional(dateSchema),
    companyId: Type.Optional(uuidSchema),
    includeSettled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const auditReportQuery = Type.Object(
  {
    from: Type.Optional(dateSchema),
    to: Type.Optional(dateSchema),
    actorId: Type.Optional(uuidSchema),
    action: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    entityType: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    entityId: Type.Optional(uuidSchema),
    sortOrder: Type.Optional(sortOrder),
    page,
    pageSize,
  },
  { additionalProperties: false },
);

export const pagination = Type.Object({
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1 }),
  total: Type.Integer({ minimum: 0 }),
});
export const reportMeta = Type.Object({
  currency: Type.Literal('INR'),
  dateBasis: Type.String(),
  from: Type.Union([dateSchema, Type.Null()]),
  to: Type.Union([dateSchema, Type.Null()]),
  balanceBasis: Type.Literal('CURRENT'),
  generatedAt: Type.String({ format: 'date-time' }),
});
export const reportEnvelope = Type.Object({
  data: Type.Array(Type.Any()),
  summary: Type.Any(),
  pagination,
  meta: reportMeta,
});
export const dashboardEnvelope = Type.Object({ data: Type.Any() });
export const statementEnvelope = Type.Object({ data: Type.Any() });

export type DashboardQuery = Static<typeof dashboardQuery>;
export type InvoiceReportQuery = Static<typeof invoiceReportQuery>;
export type VehicleInvoiceReportQuery = Static<typeof vehicleInvoiceReportQuery>;
export type TaxReportQuery = Static<typeof taxReportQuery>;
export type PaymentReportQuery = Static<typeof paymentReportQuery>;
export type ReceivablesReportQuery = Static<typeof receivablesReportQuery>;
export type DiscountReportQuery = Static<typeof discountReportQuery>;
export type CustomerStatementQuery = Static<typeof customerStatementQuery>;
export type AuditReportQuery = Static<typeof auditReportQuery>;
