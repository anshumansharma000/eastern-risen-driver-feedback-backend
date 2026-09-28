import { Type, type Static } from 'typebox';
import { invoiceBody, componentSchema, taxTreatmentSchema } from '../http/billing.schemas.js';
import { moneySchema, nonblank, rateSchema, uuidSchema } from '../http/masters.schemas.js';
const historicalTax = Type.Object(
  {
    ruleId: Type.Optional(Type.Union([uuidSchema, Type.Null()])),
    component: componentSchema,
    rate: rateSchema,
    amount: moneySchema,
  },
  { additionalProperties: false },
);
const historicalLine = Type.Object(
  {
    position: Type.Integer({ minimum: 1 }),
    description: nonblank,
    amount: moneySchema,
    taxTreatment: taxTreatmentSchema,
    taxes: Type.Array(historicalTax, { maxItems: 4 }),
    taxAmount: moneySchema,
    total: moneySchema,
  },
  { additionalProperties: false },
);
/** Normalized interchange format, not a guessed mapping of an unseen legacy database. */
export const legacyInvoiceSchema = Type.Object(
  {
    source: Type.String({ minLength: 1, maxLength: 100 }),
    sourceTable: Type.String({ minLength: 1, maxLength: 100 }),
    sourceId: Type.String({ minLength: 1, maxLength: 100 }),
    rawRecord: Type.Record(Type.String(), Type.Unknown()),
    invoiceNumber: Type.String({ minLength: 1, maxLength: 100 }),
    invoice: Type.Object(
      {
        ...invoiceBody.properties,
        placeOfSupplyState: Type.Union([Type.String(), Type.Null()]),
        placeOfSupplyCountry: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    snapshot: Type.Object(
      {
        company: Type.Record(Type.String(), Type.Unknown()),
        customer: Type.Record(Type.String(), Type.Unknown()),
        serviceCategory: Type.Record(Type.String(), Type.Unknown()),
        vehicle: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        bankAccounts: Type.Array(Type.Record(Type.String(), Type.Unknown())),
      },
      { additionalProperties: false },
    ),
    lines: Type.Array(historicalLine, { minItems: 1, maxItems: 200 }),
    subtotal: moneySchema,
    taxTotal: moneySchema,
    grandTotal: moneySchema,
  },
  { additionalProperties: false },
);
export type LegacyInvoice = Static<typeof legacyInvoiceSchema>;
