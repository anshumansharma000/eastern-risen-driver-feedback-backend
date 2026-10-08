import { Type, type Static } from 'typebox';
export const uuidSchema = Type.String({ format: 'uuid' });
export const nonblank = Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' });
export const optionalText = Type.Optional(
  Type.Union([Type.Null(), Type.String({ maxLength: 4000 })]),
);
export const moneySchema = Type.String({ pattern: '^(0|[1-9][0-9]{0,11})\\.[0-9]{2}$' });
export const rateSchema = Type.String({
  pattern: '^(100(\\.0{1,4})?|[0-9]{1,2}(\\.[0-9]{1,4})?)$',
});
export const dateSchema = Type.String({ format: 'date' });
export const statusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('INACTIVE'),
  Type.Literal('ARCHIVED'),
]);
export const paramsSchema = Type.Object({ id: uuidSchema }, { additionalProperties: false });
export const querySchema = Type.Object(
  {
    page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
    pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    status: Type.Optional(statusSchema),
    q: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);
export const versionSchema = Type.Integer({ minimum: 1 });
export const companiesBody = Type.Object(
  {
    name: nonblank,
    address: optionalText,
    phone: optionalText,
    mobileNumber: optionalText,
    email: Type.Optional(
      Type.Union([Type.String({ format: 'email', maxLength: 320 }), Type.Null()]),
    ),
    pan: optionalText,
    serviceTaxNumber: optionalText,
    cin: optionalText,
    gstNumber: optionalText,
    website: optionalText,
    state: optionalText,
    country: optionalText,
    postalCode: optionalText,
    branchOffice: optionalText,
    paymentInstructions: optionalText,
    footerNotes: optionalText,
    status: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
export type CompaniesInput = Static<typeof companiesBody>;
export const companiesUpdate = Type.Object(
  { ...companiesBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const companiesResponse = Type.Object({
  name: Type.String(),
  address: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  mobileNumber: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  pan: Type.Union([Type.String(), Type.Null()]),
  serviceTaxNumber: Type.Union([Type.String(), Type.Null()]),
  cin: Type.Union([Type.String(), Type.Null()]),
  gstNumber: Type.Union([Type.String(), Type.Null()]),
  website: Type.Union([Type.String(), Type.Null()]),
  state: Type.Union([Type.String(), Type.Null()]),
  country: Type.Union([Type.String(), Type.Null()]),
  postalCode: Type.Union([Type.String(), Type.Null()]),
  branchOffice: Type.Union([Type.String(), Type.Null()]),
  paymentInstructions: Type.Union([Type.String(), Type.Null()]),
  footerNotes: Type.Union([Type.String(), Type.Null()]),
  id: uuidSchema,
  status: statusSchema,
  version: versionSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export const bankAccountsBody = Type.Object(
  {
    companyId: uuidSchema,
    name: nonblank,
    bankName: optionalText,
    accountNumber: nonblank,
    branch: optionalText,
    ifscCode: optionalText,
    swiftCode: optionalText,
    status: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
export type BankAccountsInput = Static<typeof bankAccountsBody>;
export const bankAccountsUpdate = Type.Object(
  { ...bankAccountsBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const bankAccountsResponse = Type.Object({
  companyId: Type.String(),
  name: Type.String(),
  bankName: Type.Union([Type.String(), Type.Null()]),
  accountNumber: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  ifscCode: Type.Union([Type.String(), Type.Null()]),
  swiftCode: Type.Union([Type.String(), Type.Null()]),
  id: uuidSchema,
  status: statusSchema,
  version: versionSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export const customersBody = Type.Object(
  {
    name: nonblank,
    category: Type.Union([
      Type.Literal('AGENT'),
      Type.Literal('LEISURE'),
      Type.Literal('CORPORATE'),
    ]),
    address: optionalText,
    city: optionalText,
    state: optionalText,
    country: optionalText,
    postalCode: optionalText,
    phone: optionalText,
    mobileNumber: optionalText,
    email: Type.Optional(
      Type.Union([Type.String({ format: 'email', maxLength: 320 }), Type.Null()]),
    ),
    contactPerson: optionalText,
    pan: optionalText,
    serviceTaxNumber: optionalText,
    gstNumber: optionalText,
    market: Type.Optional(
      Type.Union([Type.Literal('DOMESTIC'), Type.Literal('INTERNATIONAL'), Type.Null()]),
    ),
    status: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
export type CustomersInput = Static<typeof customersBody>;
export const customersUpdate = Type.Object(
  { ...customersBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const customersResponse = Type.Object({
  name: Type.String(),
  category: Type.String(),
  address: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  state: Type.Union([Type.String(), Type.Null()]),
  country: Type.Union([Type.String(), Type.Null()]),
  postalCode: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  mobileNumber: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  contactPerson: Type.Union([Type.String(), Type.Null()]),
  pan: Type.Union([Type.String(), Type.Null()]),
  serviceTaxNumber: Type.Union([Type.String(), Type.Null()]),
  gstNumber: Type.Union([Type.String(), Type.Null()]),
  market: Type.Union([Type.String(), Type.Null()]),
  id: uuidSchema,
  status: statusSchema,
  version: versionSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export const guestsBody = Type.Object(
  {
    name: nonblank,
    address: optionalText,
    city: optionalText,
    state: optionalText,
    country: optionalText,
    postalCode: optionalText,
    phone: optionalText,
    mobileNumber: optionalText,
    email: Type.Optional(
      Type.Union([Type.String({ format: 'email', maxLength: 320 }), Type.Null()]),
    ),
    contactPerson: optionalText,
    market: Type.Optional(
      Type.Union([Type.Literal('DOMESTIC'), Type.Literal('INTERNATIONAL'), Type.Null()]),
    ),
    legacyLastServiceAvailed: optionalText,
    legacyLastAmountPaid: Type.Optional(Type.Union([moneySchema, Type.Null()])),
    status: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
export type GuestsInput = Static<typeof guestsBody>;
export const guestsUpdate = Type.Object(
  { ...guestsBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const guestsResponse = Type.Object({
  name: Type.String(),
  address: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  state: Type.Union([Type.String(), Type.Null()]),
  country: Type.Union([Type.String(), Type.Null()]),
  postalCode: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  mobileNumber: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  contactPerson: Type.Union([Type.String(), Type.Null()]),
  market: Type.Union([Type.String(), Type.Null()]),
  legacyLastServiceAvailed: Type.Union([Type.String(), Type.Null()]),
  legacyLastAmountPaid: Type.Union([Type.String(), Type.Null()]),
  id: uuidSchema,
  status: statusSchema,
  version: versionSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export const hotelsBody = Type.Object(
  {
    name: nonblank,
    address: optionalText,
    city: optionalText,
    state: optionalText,
    country: optionalText,
    postalCode: optionalText,
    phone: optionalText,
    mobileNumber: optionalText,
    email: Type.Optional(
      Type.Union([Type.String({ format: 'email', maxLength: 320 }), Type.Null()]),
    ),
    contactPerson: optionalText,
    market: Type.Optional(
      Type.Union([Type.Literal('DOMESTIC'), Type.Literal('INTERNATIONAL'), Type.Null()]),
    ),
    status: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
export type HotelsInput = Static<typeof hotelsBody>;
export const hotelsUpdate = Type.Object(
  { ...hotelsBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const hotelsResponse = Type.Object({
  name: Type.String(),
  address: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  state: Type.Union([Type.String(), Type.Null()]),
  country: Type.Union([Type.String(), Type.Null()]),
  postalCode: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  mobileNumber: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  contactPerson: Type.Union([Type.String(), Type.Null()]),
  market: Type.Union([Type.String(), Type.Null()]),
  id: uuidSchema,
  status: statusSchema,
  version: versionSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export const hotelRatesBody = Type.Object(
  {
    hotelId: uuidSchema,
    plan: Type.Union([Type.Literal('APAI'), Type.Literal('MAPAI'), Type.Literal('CPAI')]),
    amount: moneySchema,
    currency: Type.Literal('INR'),
    effectiveFrom: Type.Optional(Type.Union([dateSchema, Type.Null()])),
    effectiveTo: Type.Optional(Type.Union([dateSchema, Type.Null()])),
    name: nonblank,
    status: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
export type HotelRatesInput = Static<typeof hotelRatesBody>;
export const hotelRatesUpdate = Type.Object(
  { ...hotelRatesBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const hotelRatesResponse = Type.Object({
  hotelId: Type.String(),
  plan: Type.String(),
  amount: Type.String(),
  currency: Type.String(),
  effectiveFrom: Type.Union([Type.String(), Type.Null()]),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
  name: Type.String(),
  id: uuidSchema,
  status: statusSchema,
  version: versionSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export const serviceCategoriesBody = Type.Object(
  {
    name: nonblank,
    code: nonblank,
    requiresVehicle: Type.Optional(Type.Boolean()),
    status: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
export type ServiceCategoriesInput = Static<typeof serviceCategoriesBody>;
export const serviceCategoriesUpdate = Type.Object(
  { ...serviceCategoriesBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const serviceCategoriesResponse = Type.Object({
  name: Type.String(),
  code: Type.String(),
  requiresVehicle: Type.Boolean(),
  id: uuidSchema,
  status: statusSchema,
  version: versionSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export const taxRulesBody = Type.Object(
  {
    name: nonblank,
    component: Type.Union([
      Type.Literal('IGST'),
      Type.Literal('CGST'),
      Type.Literal('SGST'),
      Type.Literal('SERVICE_TAX'),
    ]),
    serviceCategoryId: Type.Optional(Type.Union([uuidSchema, Type.Null()])),
    rate: rateSchema,
    effectiveFrom: dateSchema,
    effectiveTo: Type.Optional(Type.Union([dateSchema, Type.Null()])),
    status: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
export type TaxRulesInput = Static<typeof taxRulesBody>;
export const taxRulesUpdate = Type.Object(
  { ...taxRulesBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const taxRulesResponse = Type.Object({
  name: Type.String(),
  component: Type.String(),
  serviceCategoryId: Type.Union([Type.String(), Type.Null()]),
  rate: Type.String(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
  id: uuidSchema,
  status: statusSchema,
  version: versionSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export const vendorProfilesBody = Type.Object(
  {
    vendorId: uuidSchema,
    address: optionalText,
    city: optionalText,
    state: optionalText,
    country: optionalText,
    postalCode: optionalText,
    mobileNumber: optionalText,
    market: Type.Optional(
      Type.Union([Type.Literal('DOMESTIC'), Type.Literal('INTERNATIONAL'), Type.Null()]),
    ),
    status: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
export type VendorProfilesInput = Static<typeof vendorProfilesBody>;
export const vendorProfilesUpdate = Type.Object(
  { ...vendorProfilesBody.properties, version: versionSchema },
  { additionalProperties: false },
);
export const vendorProfilesResponse = Type.Object({
  vendorId: Type.String(),
  address: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  state: Type.Union([Type.String(), Type.Null()]),
  country: Type.Union([Type.String(), Type.Null()]),
  postalCode: Type.Union([Type.String(), Type.Null()]),
  mobileNumber: Type.Union([Type.String(), Type.Null()]),
  market: Type.Union([Type.String(), Type.Null()]),
  id: uuidSchema,
  status: statusSchema,
  version: versionSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export const customerQuerySchema = Type.Object(
  {
    ...querySchema.properties,
    category: Type.Optional(
      Type.Union([Type.Literal('AGENT'), Type.Literal('LEISURE'), Type.Literal('CORPORATE')]),
    ),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
