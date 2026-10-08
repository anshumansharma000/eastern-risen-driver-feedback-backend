# Commercial quote and payment enablement API

See [Admin UX API additions](ADMIN_UX_API.md) for directory search, relationship filters, enriched booking pagination and the authoritative payment-review shortcut/count.

All staff routes below use `/api/v1/core` and the existing staff session cookie. Write operations allow `CORE_ADMIN` and `CORE_DATA_ENTRY`; customer cookies do not grant staff access. Confirmation/cancellation/completion remain `CORE_ADMIN` actions. Money is INR decimal text with exactly two fractional digits; dates are calendar dates in India (`YYYY-MM-DD`). Responses use the existing `{ "data": ... }` envelope and errors use `{ "error": { "code", "message", ... } }`.

## Behavior and rollout

Quotes now optionally store immutable calculated pricing and a resolved proposed plan per version. Calculation uses the invoice engine: ordered service lines, `TAXABLE`, `NON_TAXABLE`, `EXEMPT`, `NIL_RATED`, and supported GST components with half-up rounding per line/component. `SERVICE_TAX` remains import-only. There is no line-discount engine; existing settlement adjustments are unchanged and cannot change agreed quote pricing.

Acceptance stores the existing timestamp and audit event for the exact latest version. Creating, calculating, reviewing and accepting quotes never creates invoices or collection schedules. Accepted quotes remain accepted after expiry; expiry blocks new acceptance and does not revoke a completed acceptance. An already accepted quote can be billed after its expiry. Closed bookings cannot enable payment.

Payment enablement issues an invoice, links it, and inserts immutable milestones in one PostgreSQL transaction, using the same issuance validation, financial-year numbering, audit and invoice-issued outbox as ordinary issuance. No gateway request occurs in this transaction. Existing checkout, receipt, reconciliation, overpayment safeguards and durable gateway recovery remain in use. Invoice outbox delivery is an external effect after commit; this API does not promise atomicity across external systems.

The booking becomes `INVOICED`. Confirmation remains a separate admin action requiring confirmed receipts covering the entire initial milestone. Cancellation does not automatically refund money. Operational links and completion rules are unchanged.

1. Apply all pending migrations, including `0024_warm_blazing_skull.sql`, with the normal migration command before deploying this backend. This migration only adds nullable JSON columns; it does not backfill or alter invoices, schedules or acceptance records. Deploy the migration before switching frontend traffic to the new endpoints.
2. Deploy backend; existing quote creation, invoice linking and schedule endpoints remain available.
3. Deploy frontend together with structured quote creation, versioned private-link acceptance and review/enablement UI. Always send `quoteVersion`, including for legacy quotes. Old bodyless private acceptance remains supported only for legacy quotes; structured quotes require a version.
4. Do not try to upgrade historical quotes automatically. `pricing` and `proposedPlan` are null for legacy quotes, and customer/admin booking details label them `legacy: true`. Use the manual workflow, or create a new structured version and obtain fresh acceptance before invoice linking.
5. A booking already linked manually, or already having a schedule without new-operation activation evidence, cannot resume through enablement. Continue manual schedule creation/collection. The operation never replaces an existing invoice or schedule. A fully activated new-operation booking can replay its original enablement request.

No production migration was applied during implementation. Verification uses a disposable local database.

## Proposed plan and delayed dates

`paymentPlan.mode` is `COMPANY_DEFAULT` or `CUSTOM`. Custom mode requires 1–12 labelled, positive milestones summing exactly to calculated grand total; dates must be today or later when presented. Default mode rejects custom milestones and requires the booking's `serviceStartsOn`. It uses the existing policy, including the repository's documented fallback of 30%, 30 balance days before service and a 30-day full-payment window when no saved policy exists. The resolved policy numbers, resolution date, exact amounts and exact dates are stored on the quote.

Default plans require full payment on the quote preparation date for service within the full-payment window. Otherwise initial payment is due on that preparation date and balance before service; initial amount rounds half-up to paise, with the balance computed as the exact remainder. The existing engine falls back to one full milestone if the proposed balance date would be past or a rounded split would have a zero milestone. A missing start date requires a custom plan.

`overdueRule: KEEP_ACCEPTED_DATES` means delayed acceptance/activation preserves every accepted date. Past dates become overdue; they are never moved. Existing checkout permits collection of overdue milestones. Invoice `dueDate` is optional: if provided it must equal the final agreed milestone date and satisfy the existing invoice rule (on or after invoiceDate). For an entirely overdue plan, omit or set invoice dueDate to null; the active milestones remain the authoritative collection dates. Different dates or payment terms require a revised quote and fresh acceptance before invoice linking. The legacy schedule endpoint keeps its existing today-or-later date validation.

## Endpoints

| Method / route relative to core prefix                      | Request                                                                                                                                                                       | Response `data`                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /commercial-bookings/:id/quotes/calculate` (new)      | `lines`, `taxEffectiveDate`, `paymentPlan`                                                                                                                                    | `{ pricing, proposedPlan }`; preview only, no persisted quote                                                                                       |
| `POST /commercial-bookings/:id/quotes` (extended, HTTP 201) | Existing `description`, `inclusions`, `exclusions`, `terms`, optional `expiresOn`; structured `lines`, `taxEffectiveDate`, `paymentPlan` together; optional `total` assertion | Persisted quote: `id`, `bookingId`, `version`, scope fields, `total`, `currency`, `expiresOn`, `acceptedAt`, `createdAt`, `pricing`, `proposedPlan` |
| `POST /commercial-bookings/:id/billing-review` (new)        | Partial invoice-only details directly as body; `{}` is allowed                                                                                                                | `bookingId`, `quoteId`, `quoteVersion`, `invoiceFields`, `pricing`, `proposedPlan`, `missingFields`, `errors`, `eligible`, `reviewToken`            |
| `POST /commercial-bookings/:id/enable-payment` (new)        | `quoteId`, `reviewToken`, complete `invoiceDetails`                                                                                                                           | Existing admin GET booking shape: `booking`, `quotes`, allocated `milestones`, `orders`, `attempts`, `reconciliation`, full `invoice`               |
| `GET /commercial-bookings/:id` (extended)                   | None                                                                                                                                                                          | Quote rows gain `pricing`, `proposedPlan`, `legacy`; booking gains nullable internal `paymentActivation` evidence                                   |
| `GET /public/bookings/:token` (extended)                    | None                                                                                                                                                                          | Customer detail below                                                                                                                               |
| `POST /public/bookings/:token/accept` (extended)            | `{ quoteVersion }`; version mandatory for structured quotes                                                                                                                   | Accepted quote row; no billing artifacts                                                                                                            |

Account routes use `/api/v1/customer/accounts/:customerId/bookings/:bookingId`: `GET` returns the exact same customer detail; `POST .../accept` still requires `{ quoteVersion }`. Existing membership checks, booking/customer isolation, session revocation, private-token rotation and token recheck under the booking lock remain unchanged.

Checkout routes are unchanged: `POST /api/v1/core/public/bookings/:token/milestones/:milestoneId/checkout` and `POST /api/v1/customer/accounts/:customerId/bookings/:bookingId/milestones/:milestoneId/checkout`. Reconciliation stays at the existing private/account `.../orders/:orderId/reconcile` routes. Do not call checkout from the proposed plan: only active milestones have checkout IDs.

For legacy quote creation, send existing gross `total` without any structured fields. Mixing partial structured fields is rejected. If a supplied structured `total` differs from the authoritative calculation it is rejected. Structured legacy invoice linking validates complete line/tax scope as well as company, customer, category and total. Manual schedule creation for a structured quote requires the exact agreed plan.

`invoiceFields` locks company/customer/category identities and lines from booking/quote data. Required missing fields are drawn from `invoiceDate`, `guestDisplayText`, `serviceProvidedAt`, `placeOfSupplyState`, `placeOfSupplyCountry`, `bankAccountIds`; staff supply actual values, including an empty bank list if appropriate. Optional invoice-only fields are `guestId`, `passengerCount`, `vehicleId`, `dueDate`, `label`. Existing active-party, company address/state/country, bank ownership, vehicle, tax and period validation still applies. Invoice-only details are not persisted until enablement. The review may return `eligible: false` and multiple errors; it never issues an invoice. Pricing/tax configuration changes are blocked even if the grand total happens to remain equal.

## JSON examples

IDs below are illustrative. Dates must satisfy the rules at request time.

Calculation request:

```json
{
  "lines": [
    {
      "description": "Tour transport",
      "amount": "1000.01",
      "taxTreatment": "NON_TAXABLE",
      "taxComponents": []
    }
  ],
  "taxEffectiveDate": "2026-10-07",
  "paymentPlan": {
    "mode": "CUSTOM",
    "milestones": [
      { "label": "Initial payment", "amount": "300.00", "dueOn": "2026-10-07" },
      { "label": "Balance", "amount": "700.01", "dueOn": "2026-11-07" }
    ]
  }
}
```

Calculation response (the same objects are stored verbatim on the quote):

```json
{
  "data": {
    "pricing": {
      "lines": [
        {
          "position": 1,
          "description": "Tour transport",
          "amount": "1000.01",
          "taxTreatment": "NON_TAXABLE",
          "taxes": [],
          "taxAmount": "0.00",
          "total": "1000.01"
        }
      ],
      "subtotal": "1000.01",
      "taxTotal": "0.00",
      "grandTotal": "1000.01",
      "taxEffectiveDate": "2026-10-07",
      "currency": "INR",
      "rounding": "HALF_UP_PER_LINE_COMPONENT"
    },
    "proposedPlan": {
      "mode": "CUSTOM",
      "milestones": [
        { "label": "Initial payment", "amount": "300.00", "dueOn": "2026-10-07" },
        { "label": "Balance", "amount": "700.01", "dueOn": "2026-11-07" }
      ],
      "resolvedOn": "2026-10-07",
      "policy": null,
      "overdueRule": "KEEP_ACCEPTED_DATES"
    }
  }
}
```

Quote creation request (default mode requires a booking service date):

```json
{
  "description": "Tour transport",
  "inclusions": "Vehicle and driver",
  "exclusions": "Meals",
  "terms": "Payment according to proposed plan",
  "expiresOn": "2026-10-20",
  "lines": [
    {
      "description": "Tour transport",
      "amount": "1000.01",
      "taxTreatment": "NON_TAXABLE",
      "taxComponents": []
    }
  ],
  "taxEffectiveDate": "2026-10-07",
  "paymentPlan": { "mode": "COMPANY_DEFAULT" }
}
```

For a 2026-12-07 service date and 30%/30-day/30-day policy, the created quote contains `total: "1000.01"`, the pricing above, `proposedPlan.mode: "COMPANY_DEFAULT"`, `policy: { initialPercent: 30, balanceDaysBefore: 30, fullPaymentWithinDays: 30 }`, and milestones of `300.00` due 2026-10-07 and `700.01` due 2026-11-07. Each new save increments version and has `acceptedAt: null`.

Customer detail, after accepting that default quote and before enablement:

```json
{
  "data": {
    "reference": "TOUR-2026-001",
    "title": "Tour transport",
    "status": "QUOTED",
    "serviceStartsOn": "2026-12-07",
    "serviceEndsOn": null,
    "quote": {
      "id": "11111111-1111-4111-8111-111111111111",
      "version": 1,
      "legacy": false,
      "description": "Tour transport",
      "inclusions": "Vehicle and driver",
      "exclusions": "Meals",
      "terms": "Payment according to proposed plan",
      "total": "1000.01",
      "currency": "INR",
      "expiresOn": "2026-10-20",
      "acceptedAt": "2026-10-07T07:00:00.000Z",
      "pricing": {
        "lines": [
          {
            "position": 1,
            "description": "Tour transport",
            "amount": "1000.01",
            "taxTreatment": "NON_TAXABLE",
            "taxes": [],
            "taxAmount": "0.00",
            "total": "1000.01"
          }
        ],
        "subtotal": "1000.01",
        "taxTotal": "0.00",
        "grandTotal": "1000.01",
        "taxEffectiveDate": "2026-10-07",
        "currency": "INR",
        "rounding": "HALF_UP_PER_LINE_COMPONENT"
      },
      "proposedPlan": {
        "mode": "COMPANY_DEFAULT",
        "milestones": [
          { "label": "Initial payment", "amount": "300.00", "dueOn": "2026-10-07" },
          { "label": "Balance", "amount": "700.01", "dueOn": "2026-11-07" }
        ],
        "policy": { "initialPercent": 30, "balanceDaysBefore": 30, "fullPaymentWithinDays": 30 },
        "resolvedOn": "2026-10-07",
        "overdueRule": "KEEP_ACCEPTED_DATES"
      }
    },
    "invoice": null,
    "milestones": [],
    "payments": [],
    "paymentReady": false,
    "nextAction": "AWAIT_ADMIN_PAYMENT_ENABLEMENT",
    "paymentReviewRequired": false
  }
}
```

Review request:

```json
{
  "invoiceDate": "2026-10-07",
  "guestDisplayText": "Named tour group",
  "serviceProvidedAt": "ODISHA",
  "placeOfSupplyState": "ODISHA",
  "placeOfSupplyCountry": "INDIA",
  "bankAccountIds": []
}
```

Complete eligible review response contains the accepted pricing and proposed plan above, plus these fields (abbreviated example; `pricing` and `proposedPlan` are not omitted by the API):

```json
{
  "bookingId": "22222222-2222-4222-8222-222222222222",
  "quoteId": "11111111-1111-4111-8111-111111111111",
  "quoteVersion": 1,
  "invoiceFields": {
    "companyId": "33333333-3333-4333-8333-333333333333",
    "customerId": "44444444-4444-4444-8444-444444444444",
    "serviceCategoryId": "55555555-5555-4555-8555-555555555555",
    "invoiceDate": "2026-10-07",
    "guestDisplayText": "Named tour group",
    "serviceProvidedAt": "ODISHA",
    "placeOfSupplyState": "ODISHA",
    "placeOfSupplyCountry": "INDIA",
    "bankAccountIds": [],
    "lines": [
      {
        "description": "Tour transport",
        "amount": "1000.01",
        "taxTreatment": "NON_TAXABLE",
        "taxComponents": []
      }
    ]
  },
  "missingFields": [],
  "errors": [],
  "eligible": true,
  "reviewToken": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Enablement request (use the real returned token, not the example):

```json
{
  "quoteId": "11111111-1111-4111-8111-111111111111",
  "reviewToken": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "invoiceDetails": {
    "invoiceDate": "2026-10-07",
    "guestDisplayText": "Named tour group",
    "serviceProvidedAt": "ODISHA",
    "placeOfSupplyState": "ODISHA",
    "placeOfSupplyCountry": "INDIA",
    "bankAccountIds": []
  }
}
```

Success returns HTTP 200 with the normal full admin booking detail, including an `ISSUED` invoice (its existing `invoiceNumber`, `financialYear`, totals, lines, taxes, snapshot and settlement fields), the booking's `invoiceId` and `status: INVOICED`, and active milestones with IDs for checkout. Customer detail subsequently has `paymentReady: true` and `nextAction: PAY`; the acceptance timestamp is unchanged.

## Frontend TypeScript contracts

```ts
export type Money = string;
export type LocalDate = string;
export type UUID = string;
export type TaxTreatment = 'TAXABLE' | 'NON_TAXABLE' | 'EXEMPT' | 'NIL_RATED';
export type TaxComponent = 'IGST' | 'CGST' | 'SGST' | 'SERVICE_TAX';
export interface ServiceLine {
  description: string;
  amount: Money;
  taxTreatment: TaxTreatment;
  taxComponents: TaxComponent[];
}
export interface AppliedTax {
  ruleId: UUID;
  component: TaxComponent;
  rate: string;
  amount: Money;
}
export interface CalculatedLine {
  position: number;
  description: string;
  amount: Money;
  taxTreatment: TaxTreatment;
  taxes: AppliedTax[];
  taxAmount: Money;
  total: Money;
}
export interface Pricing {
  lines: CalculatedLine[];
  subtotal: Money;
  taxTotal: Money;
  grandTotal: Money;
  taxEffectiveDate: LocalDate;
  currency: 'INR';
  rounding: 'HALF_UP_PER_LINE_COMPONENT';
}
export interface ProposedMilestone {
  label: string;
  amount: Money;
  dueOn: LocalDate;
}
export interface Policy {
  initialPercent: number;
  balanceDaysBefore: number;
  fullPaymentWithinDays: number;
}
export type PaymentPlanInput =
  { mode: 'COMPANY_DEFAULT' } | { mode: 'CUSTOM'; milestones: ProposedMilestone[] };
export interface ProposedPlan {
  mode: 'COMPANY_DEFAULT' | 'CUSTOM';
  milestones: ProposedMilestone[];
  policy: Policy | null;
  resolvedOn: LocalDate;
  overdueRule: 'KEEP_ACCEPTED_DATES';
}
export interface CalculateQuoteRequest {
  lines: ServiceLine[];
  taxEffectiveDate: LocalDate;
  paymentPlan: PaymentPlanInput;
}
export interface CalculateQuoteResponse {
  pricing: Pricing;
  proposedPlan: ProposedPlan;
}
export interface QuoteScope {
  description: string;
  inclusions: string;
  exclusions: string;
  terms: string;
  expiresOn?: LocalDate | null;
}
export type CreateQuoteRequest = QuoteScope &
  ((CalculateQuoteRequest & { total?: Money }) | { total: Money });
export interface QuoteRow {
  id: UUID;
  bookingId: UUID;
  version: number;
  description: string;
  inclusions: string;
  exclusions: string;
  terms: string;
  total: Money;
  currency: 'INR';
  expiresOn: LocalDate | null;
  acceptedAt: string | null;
  createdAt: string;
  pricing: Pricing | null;
  proposedPlan: ProposedPlan | null;
}
export interface InvoiceDetails {
  invoiceDate: LocalDate;
  guestDisplayText: string;
  serviceProvidedAt: string;
  placeOfSupplyState: string;
  placeOfSupplyCountry: string;
  bankAccountIds: UUID[];
  guestId?: UUID | null;
  passengerCount?: number | null;
  vehicleId?: UUID | null;
  dueDate?: LocalDate | null;
  label?: string | null;
}
export type BillingReviewRequest = Partial<InvoiceDetails>;
export interface BillingReview {
  bookingId: UUID;
  quoteId: UUID | null;
  quoteVersion: number | null;
  invoiceFields: Partial<InvoiceDetails> & {
    companyId: UUID;
    customerId: UUID;
    serviceCategoryId: UUID;
    lines: ServiceLine[];
  };
  pricing: Pricing | null;
  proposedPlan: ProposedPlan | null;
  missingFields: (keyof InvoiceDetails)[];
  errors: { code: string; message: string }[];
  eligible: boolean;
  reviewToken: string | null;
}
export interface EnablePaymentRequest {
  quoteId: UUID;
  reviewToken: string;
  invoiceDetails: InvoiceDetails;
}
export type EnablePaymentResponse<ExistingAdminBookingDetail> = ExistingAdminBookingDetail;
export type CustomerQuote = Omit<QuoteRow, 'bookingId' | 'createdAt'> & { legacy: boolean };
export interface ActiveMilestone extends ProposedMilestone {
  id: UUID;
  position: number;
  status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID';
  remainingAmount: Money;
  paid: boolean;
  remaining: Money;
}
export interface CustomerBookingDetail {
  reference: string;
  title: string;
  status: 'DRAFT' | 'QUOTED' | 'INVOICED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
  serviceStartsOn: LocalDate | null;
  serviceEndsOn: LocalDate | null;
  quote: CustomerQuote | null;
  invoice: {
    number: string | null;
    date: LocalDate;
    total: Money;
    received: Money;
    due: Money;
    paymentStatus: string;
  } | null;
  milestones: ActiveMilestone[];
  payments: { number: string; date: LocalDate; amount: Money; method: string }[];
  paymentReady: boolean;
  paymentReviewRequired: boolean;
  nextAction:
    | 'AWAIT_QUOTE'
    | 'REVIEW_AND_ACCEPT'
    | 'QUOTE_EXPIRED'
    | 'AWAIT_ADMIN_PAYMENT_ENABLEMENT'
    | 'PAY'
    | 'PAYMENT_COMPLETE'
    | 'BOOKING_CLOSED';
}
export interface ApiEnvelope<T> {
  data: T;
}
```

`paymentReady` reports issued-invoice/schedule/lifecycle readiness. It does not promise provider availability or that every milestone can create another order. Continue respecting milestone balances, `paymentReviewRequired` and existing checkout/reconciliation outcomes; fully paid milestones cannot collect again.

## Errors, stale reviews and retries

| Code                                                                                         | Frontend action                                                                                                                              |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUEST_VALIDATION_FAILED` (400), `CORE_VALIDATION_FAILED` (422)                            | Correct invalid fields; monetary text, plan sums and dates are validated server-side                                                         |
| `PAYMENT_PLAN_PREREQUISITES_MISSING` (409)                                                   | Provide a service start date or choose custom milestones                                                                                     |
| `QUOTE_VERSION_REQUIRED` (409)                                                               | Reload terms and send exact quoteVersion                                                                                                     |
| `QUOTE_VERSION_CHANGED`, `QUOTE_EXPIRED`, `QUOTE_NOT_ACCEPTABLE` (409)                       | Reload booking; show latest terms or request revised quote; closed bookings cannot accept                                                    |
| `QUOTE_NOT_ACCEPTED` (409 or review errors)                                                  | Obtain latest-version customer acceptance                                                                                                    |
| `LEGACY_QUOTE_REQUIRES_REVISION` (409 or review errors)                                      | Continue manual billing, or prepare structured revision and obtain fresh acceptance                                                          |
| `LEGACY_BILLING_CONFLICT` (409 or review errors)                                             | Continue manual flow for an existing invoice/schedule; never replace artifacts                                                               |
| `QUOTE_PRICING_REVIEW_REQUIRED` (409 or review errors)                                       | Pricing/tax details changed; resolve applicable configuration, or revise quote and obtain fresh acceptance; never silently accept new totals |
| `AGREED_PAYMENT_TERMS_CHANGED` (409 or review errors)                                        | Restore accepted payment terms; changes require a quote revision before invoice linking                                                      |
| `STALE_BILLING_REVIEW` (409)                                                                 | Reload/review and display current invoice/terms before enabling again                                                                        |
| `IDEMPOTENCY_CONFLICT` (409)                                                                 | Another enablement request already succeeded with different data; reload existing booking                                                    |
| Existing `BOOKING_ALREADY_INVOICED`, `SCHEDULE_ALREADY_SET`, `BOOKING_NOT_INVOICEABLE` (409) | Reload and use existing billing state                                                                                                        |
| Existing `CORE_ACCESS_REQUIRED` (403), authentication 401, inaccessible booking/token 404    | Use proper staff/customer entry point; do not retry with unrelated identities                                                                |
| Existing checkout, overpayment and provider errors                                           | Use unchanged checkout/reconciliation handling; acceptance remains intact                                                                    |

Review token is an opaque SHA-256 digest of booking/quote identity, invoice fields, current prepared master/tax snapshot and accepted plan. It is a concurrency token, not authorization. It changes if any relevant review data changes. Staff must submit the **same invoiceDetails used in the eligible review**; supplying additional optional fields requires a new review. Keep the exact enablement request for network retries. No separate Idempotency-Key header is needed: the booking row lock plus persisted activation request hash makes the entire operation idempotent per booking. JSON key order does not matter; changing optional-field presence or values is a different request.

On a timeout, retry the same request. On a failed transaction, all draft/issued invoice rows, counters, audit/outbox writes, booking links and schedules roll back and the same request can be retried. On committed success followed by response loss, the stored hash returns current booking state without new artifacts. Do not create an invoice separately as timeout recovery. Legacy link/schedule mutations take the same booking lock and cannot install conflicting artifacts concurrently.

Preview results can change before quote save; always render the returned persisted quote before presentation/acceptance. An ineligible review returns null reviewToken. Quote revision requires fresh acceptance. There is no post-invoice amendment process, retrospective data backfill, automatic invoice issuance on acceptance, or automatic confirmation/refund.

## Verification results

All migrations applied successfully to a fresh disposable PostgreSQL 16 database. `npm run check` with that database passed formatting, ESLint, TypeScript checks, build, and all 40 test files: **231 passed, 1 intentionally skipped**. The skip is the existing legacy manual trip-section assignment test superseded by derived engagements.

New database tests cover calculation parity for supported tax modes and paise rounding, policy snapshot stability, missing prerequisites, exact-version acceptance, expired/cancelled quotes, stale reviews, identical private/account responses, unauthorized/customer isolation, concurrent enablement retries, unchanged invoice counts/counters after rollback, manual-link races and partial state, full scope consistency, tax changes and delayed activation. Existing reconciliation, overpayment, receipt allocation and confirmation regressions remain passing.

Integration tests use a real database and fake payment-provider responses; live gateway collection and external outbox consumers were not exercised. The migration/backend/frontend deployment remains an operational rollout step. No new post-invoice amendments, historical data reconstruction or discount engine was implemented, as required by scope.
