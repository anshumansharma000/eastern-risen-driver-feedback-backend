# Eastern Risen core API

See [Admin UX API additions](ADMIN_UX_API.md) for directory search, relationship filters, enriched booking pagination and the authoritative payment-review shortcut/count.

> The canonical Core product specification is [PRODUCT.md](PRODUCT.md). This file is
> a concise technical implementation guide; resolve product behavior and scope from
> `PRODUCT.md`.

The core API runs alongside feedback in the existing Fastify application. Its routes
are under `/api/v1/core`; existing feedback URLs and permissions are preserved.
OpenAPI at `/docs` is the authoritative request/response reference.

## Module boundaries

- `src/modules/core/domain`: decimal arithmetic, tax selection, payment rules and dates.
  Calculations do not use PostgreSQL, HTTP, or feedback objects.
- `src/modules/core/application`: transport-independent billing inputs and contracts
  for shared identity and the vendor/vehicle catalog.
- `src/modules/core/persistence`: dedicated `core` PostgreSQL schema, repositories,
  document counters, audit events, and transactional outbox.
- `src/modules/core/http`: TypeBox validation, response projections, permissions and routes.
- `src/modules/core/legacy`: explicitly normalized historical invoice ingestion.
- `src/modules/core/index.ts`: module composition and route registration.

The composition root supplies a schema-independent database query surface and two
business adapters. `CoreIdentityAdapter` lives with authentication and owns account
writes, password hashing, and session revocation. `createSharedCatalogAdapter` owns
connections to existing vendor/vehicle services. Core does not query their tables.

Core tables reference other core tables. Account IDs and vendor profile IDs are
external references, deliberately without cross-module foreign keys. They are
validated through adapters where applicable. Each record has one owner: shared
vendor contact data stays in the shared catalog, while extra vendor fields live in
a dedicated profile. Vehicle registration, type, owner contact and owner banking
fields all live on the single shared vehicle entity.

### Event boundary and later extraction

Invoice issue/cancellation and receipt creation/confirmation/reversal persist
versioned events in `core.outbox` inside their business transactions. Event payloads
contain identifiers rather than financial snapshots or personal data. No worker
publishes these events yet because there is no consumer. Do not mark events
published until a future consumer acknowledges delivery; consumers must deduplicate
by outbox event ID.

To extract core:

1. Move this module, its tables and migrations to a separate application/database.
2. Replace the identity/session hook and catalog adapters with authenticated service
   clients or a shared identity provider. Keep the same application contracts.
3. Add outbox delivery and idempotent consumers where cross-service workflows need it.
4. Give each service database credentials restricted to its owned schema.
5. Route `/api/v1/core` to the new service while preserving its HTTP contract.

Local catalog writes currently call the shared service. Creating a vendor and its
optional core profile remains two explicit operations. Vehicle creation and update
are single atomic catalog operations because the former vehicle profile has been
merged into the vehicle entity.

An architecture test prevents core from importing feedback modules or the shared
application schema. This is an extraction boundary, not a claim that separation
requires no operational work.

## Authentication and permissions

`POST /api/v1/auth/core/login` accepts `username` and `password`. The `username` field
can contain either the core account's username or email address (up to 320 characters).
Both are matched case-insensitively after trimming surrounding whitespace. Login uses
the existing secure session-cookie infrastructure. `/api/v1/auth/me` and `/logout` are shared.
Username is case-insensitively unique; existing accounts retain a null username.
Core users can read and edit their own username, display name, and email at
`GET|PATCH /api/v1/core/profile`; `POST /api/v1/core/profile/change-password`
changes the password, revokes all sessions, and clears the current cookie.

| Role                        | Access                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CORE_ADMIN`                | All core operations, including tax/company configuration, users, cancellation, reversals and settlement discounts                         |
| `CORE_DATA_ENTRY`           | Read core data, maintain customers/guests/hotels/profiles and shared catalog details, create/edit/issue invoices, record/confirm receipts |
| `CORE_REPORT_VIEWER`        | Read core masters, invoices, receipts through invoice detail, receivables and guest activity                                              |
| Existing `ADMIN` / `DRIVER` | Existing feedback access; no automatic core access                                                                                        |

Core roles do not grant feedback administrator access. This initial identity model
retains one role per account; simultaneous feedback and core administration on one
account is not implemented. If needed, extend shared identity with explicit module
memberships rather than widening either administrator guard. Emails remain globally
unique. Core permissions currently cover all companies in this installation;
company-specific tenancy is not implemented.

Bootstrap a core administrator with the existing environment-based provisioning
pattern (use secure secret injection in deployment):

```sh
export CORE_ADMIN_USERNAME=core-admin
export CORE_ADMIN_EMAIL=admin@example.com
export CORE_ADMIN_DISPLAY_NAME='Core Administrator'
read -s CORE_ADMIN_PASSWORD
export CORE_ADMIN_PASSWORD
npm run core:admin:create
unset CORE_ADMIN_PASSWORD
```

Passwords require 12–128 characters and use the existing Argon2id hasher. Core user
access changes and password resets revoke sessions. The final active core admin
cannot be disabled or demoted.

User administration:

- `GET|POST /users`
- `PUT /users/:id` — username, email, displayName
- `PATCH /users/:id/access` — role, status
- `POST /users/:id/password-reset` — password

All paths below are relative to `/api/v1/core`.

## Masters and the legacy model

Each dedicated core master supports `GET /resource`, `GET /resource/:id`,
`POST /resource`, and `PUT /resource/:id`:

| Resource             | Purpose                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `companies`          | Legal company details, legacy identifiers, address and invoice footer defaults |
| `bank-accounts`      | Multiple company-owned bank accounts; numbers remain text                      |
| `customers`          | One billing customer master, category `AGENT`, `LEISURE`, or `CORPORATE`       |
| `guests`             | Travellers, independently classified `DOMESTIC` / `INTERNATIONAL` when known   |
| `hotels`             | Hotel contact/location information                                             |
| `hotel-rates`        | Hotel, plan `APAI`/`MAPAI`/`CPAI`, amount, INR currency, validity period       |
| `service-categories` | Invoice-for label, HSN/SAC code, lifecycle status and `requiresVehicle` flag   |
| `tax-rules`          | Component, rate, optional service category, inclusive effective dates          |
| `vendor-profiles`    | External vendor ID, additional location/mobile/market information              |

Master status is `ACTIVE`, `INACTIVE`, or `ARCHIVED`. Lists accept `page` (default 1),
`pageSize` (default 25, maximum 100), and optional `status`. Customers additionally
support `category` and literal substring `q` for the billing picker, for example
`/customers?category=AGENT&status=ACTIVE&q=balaji`.

Updates are **full replacements of editable fields**, including a required `version`
from the preceding response. Omitted optional fields clear to null; omitted status
means ACTIVE. A stale version returns 409. There are no hard-delete endpoints.

Shared catalog endpoints support `GET|POST /vendors`, `GET|POST /vehicles`,
`GET|PUT /vendors/:id`, `GET|PUT /vehicles/:id`, and administrator-only
`PATCH /vendors/:id/status` / `PATCH /vehicles/:id/status`. These preserve existing
catalog status values `ACTIVE`, `DEACTIVATED`, `ARCHIVED`. Their updates retain the
existing catalog's concurrency semantics; core master version numbers do not apply.
Vehicle request and response bodies include required `registrationNumber`,
`displayName`, and `vehicleType`, plus nullable `registeredOwner`, `address`,
`contactNumber`, `accountNumber`, `ifscCode`, and `bankName`. These fields belong to
the shared vehicle record and are returned consistently by both feedback-admin and
core vehicle endpoints. The old `/vehicle-profiles` endpoints no longer exist.

Configure service categories for Advertisement, Air ticket, Car Service, Hotel
Booking, Itinerary, MICE, Service charge, Train ticket and Travel Service. No tax
rates or HSN/SAC codes are seeded: the sample's code/rate must not become an
unsupported default for every service. Service-category IDs are internal UUIDs.
Set `requiresVehicle: true` on Car Service. The vehicle requirement is explicit
rather than inferred from the editable category name or its HSN/SAC code.

Companies may retain unknown address/state/country as null during migration, but
these must be completed before issuing new invoices. Hotel-rate start dates can
remain null when legacy data only supplies a validity end date. New tax rules need
an effective-from date. Optional market values remain null when unknown.

## Commercial booking and Cashfree flow

Staff create a Core commercial booking, add a versioned quote, and share its private token with the customer. Only a customer holding that token can accept the latest quote. Staff then create and issue the full invoice through the existing invoice API, link it to the commercial booking, and create an INR payment schedule. The invoice must match the accepted quote's company, customer, service category, and total. The payment schedule must sum to the invoice total. No payment is allowed before an issued invoice is linked.

The company default is 30% initially and 70% 30 days before travel; bookings within 30 days of travel require full payment. A Core administrator can configure the percentages and timing per company at `PUT /companies/:id/payment-policy`. Staff can supply explicit milestones when creating the schedule. Dates and amounts are frozen once the schedule has been set. The legacy operational booking has an optional `commercialBookingId` and can link only after commercial confirmation.

`GET /commercial-bookings/:id` returns `{ data: { booking, quotes, milestones, orders, invoice } }`.
Every milestone includes a derived `remainingAmount` and `status`: `PENDING` for no
coverage, `PARTIALLY_PAID` for partial coverage, and `PAID` for full coverage. Only
confirmed receipts for the linked invoice cover milestones, in ascending `position`
order, regardless of which milestone a gateway order references. Pending/reversed
receipts and order statuses do not contribute. Settlement discounts reduce invoice
debt separately and do not count as collected cash. All allocation uses integer paise.
Public booking milestones expose the same `status` and `remainingAmount`, retaining
`paid` and `remaining` as compatible aliases. No milestone `paidAt` is stored or
inferred from gateway timestamps.

Confirmation uses the same allocation and requires the first milestone to be fully
covered. Its balance check, booking transition, and audit entry are transactional;
invoice locks serialize this check with receipt confirmation/reversal. Gateway
reconciliation locks the order and commits its confirmed receipt and order link in
one transaction, retaining provider-payment idempotency and overpayment checks.
Existing bookings derive their balances on the next detail read; no allocation
backfill or repair command is needed. Clients must fetch fresh details after
reconciliation or receipt mutations to display changes.

| Staff endpoint                                             | Purpose                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /commercial-bookings`                                | Create booking and return the private token once.                        |
| `GET /commercial-bookings`, `GET /commercial-bookings/:id` | List and inspect commercial records.                                     |
| `POST /commercial-bookings/:id/quotes`                     | Create the next quote version.                                           |
| `GET /commercial-bookings/:id/available-invoices`          | Search all invoices and show booking-link eligibility.                   |
| `POST /commercial-bookings/:id/rotate-link`                | Replace a lost or compromised private token.                             |
| `POST /commercial-bookings/:id/invoice`                    | Link an issued, matching invoice after quote acceptance.                 |
| `POST /commercial-bookings/:id/schedule`                   | Create default or explicit payment milestones.                           |
| `POST /commercial-bookings/:id/status`                     | Confirm, cancel, or complete. Confirmation requires the initial payment. |
| `POST /payment-orders/:orderId/reconcile`                  | Retry provider verification and receipt creation.                        |

`GET /commercial-bookings/:id/available-invoices?q=itinerary&page=1&pageSize=25` searches the full invoice register before evaluating booking eligibility. `q` matches invoice number, customer name, guest name/text, invoice label (the optional tour/description text), and invoice line description, case insensitively. All statuses, companies, customers, categories, totals, and link states are considered. The response is `{ data: [{ id, invoiceNumber, financialYear, invoiceDate, status, grandTotal, customerName, guestName, label, lineDescription, eligible, unavailableReasons }], pagination: { page, pageSize, total } }`. `invoiceNumber` and `financialYear` are null for drafts. `lineDescription` is the first matching line description when searching by line text, or the first line when `q` is omitted; it may be null. Results are sorted by invoice date descending and paginated; `pageSize` defaults to 25 and may be up to 100. `unavailableReasons` explains any status, link, company, customer, category, quote-acceptance, or total mismatch. Link only a result with `eligible: true` using `POST /commercial-bookings/:id/invoice` and `{ "invoiceNumber": "I/2627/000001", "financialYear": "2627" }`. The link operation rechecks eligibility. The older `{ "invoiceId": "..." }` request remains supported. The booking continues to store the invoice UUID internally.

The customer endpoints are `GET /public/bookings/:token`, `POST /public/bookings/:token/accept`, `POST /public/bookings/:token/milestones/:milestoneId/checkout`, and `POST /public/bookings/:token/orders/:orderId/reconcile`. Checkout returns a Cashfree `payment_session_id` for the hosted checkout integration. A customer link can be copied by staff; no email or WhatsApp delivery is performed by this backend.

Cashfree notifications arrive at `POST /payments/webhooks/cashfree` under the Core prefix. Configure this exact URL in the Cashfree dashboard. The endpoint verifies the signature over the original body and timestamp, then atomically records a deduplicated event identity and schedules PostgreSQL-backed reconciliation. It acknowledges only after that transaction commits; gateway outages do not prevent notification acceptance. The worker fetches the order and all attempts from Cashfree before creating an invoice-linked `GATEWAY` receipt. It checks currency and amount, and uses the provider payment ID as the receipt idempotency key. Gateway receipt creation is not available through the staff receipt endpoint. Keep `CASHFREE_ENV`, `CASHFREE_APP_ID`, and `CASHFREE_SECRET_KEY` in server-side environment secrets. `CASHFREE_ENV` is `sandbox` or `production`. Set `CASHFREE_WEBHOOK_URL` to the public notification URL so new orders include `notify_url`.

If Cashfree confirms money received after the invoice has been cancelled or its outstanding balance has changed, the successful attempt is marked with accounting status `REVIEW_REQUIRED`, retaining its provider payment identifier and timestamp. The order is also marked `REVIEW_REQUIRED` unless it already has an applied receipt; extra successful attempts never erase the original receipt. The system does not invent a receipt or silently discard the collection; finance must resolve it before treating the booking as settled.

The existing invoice remains the sole tax and receivable record. Cashfree orders are collection records. There is no pre-invoice advance support, automated refund, credit note, invoice PDF, or automatic payment-link messaging in this release. Gateway receipts cannot be reversed through the manual receipt endpoint because that would not return money to the customer. Paid-booking refunds and related tax adjustments require a separate reviewed process before reversing accounting records.

## Invoice workflow

1. Create required masters and configure effective tax rates.
2. `POST /invoices` creates a numbered-line draft and calculates its quote.
3. `PUT /invoices/:id` replaces a draft using its current version.
4. `POST /invoices/:id/issue` with `{ "version": 1 }` issues the reviewed draft.
5. `GET /invoices/:id` returns the preserved invoice, numbered lines, applied taxes,
   receipt and adjustment histories, and current outstanding balance.
6. `POST /invoices/:id/cancel` requires an administrator and a reason. Active
   receipts/adjustments must first be reversed. The invoice number is retained.

Example draft (replace symbolic IDs with UUIDs):

```json
{
  "companyId": "COMPANY_UUID",
  "customerId": "CUSTOMER_UUID",
  "guestDisplayText": "Traveller X 04",
  "passengerCount": 4,
  "serviceCategoryId": "ITINERARY_UUID",
  "invoiceDate": "2026-08-20",
  "dueDate": "2026-08-30",
  "serviceProvidedAt": "ODISHA",
  "placeOfSupplyState": "ODISHA",
  "placeOfSupplyCountry": "INDIA",
  "bankAccountIds": ["BANK_ACCOUNT_UUID"],
  "lines": [
    {
      "description": "4 PAX / itinerary / travel dates / hotel / vehicle",
      "amount": "81500.00",
      "taxTreatment": "TAXABLE",
      "taxComponents": ["IGST"]
    }
  ]
}
```

Guest text describes the traveller/group; customer identifies who owes the money.
`guestId` and `label` are optional. Group text is retained without parsing names or
manufacturing individual travellers. `serviceProvidedAt` is display text, separate
from structured supply location. The category/code currently applies to the whole
invoice, as in the legacy workflow; mixed-category invoicing is not implemented.

Invoice bodies accept an optional nullable `vehicleId`. It is required when the
selected service category has `requiresVehicle: true` and rejected for every other
category. The selected vehicle must be active. Invoice responses expose the ID at
the top level and in `details`, and snapshot its display name, registration number
and vehicle type. Issued invoices therefore remain reportable by their historical
vehicle identity even if the shared vehicle master is later changed.

Amounts are **decimal strings**, with exactly two fractional digits and up to 12
integer digits. Arithmetic uses BigInt paise. Rates accept up to four fractional
digits. Tax is rounded half-up per line/component; totals sum those rounded values.
With an applicable 5% IGST rule, the example yields 81,500.00 + 4,075.00 = 85,575.00.
The initial monetary contract is INR throughout; market type does not imply currency.

Rate lookup uses the invoice date in this initial workflow. The specific service
rule wins over an all-services rule (`serviceCategoryId: null`). Overlapping active
rules with the same component and service scope are rejected transactionally. IGST
cannot combine with CGST/SGST; CGST and SGST must be selected together. Non-taxable,
exempt and nil-rated rows cannot carry selected tax components. Legacy service tax
can be stored/imported, but cannot be selected on new invoices.

These are configured calculation rules, not a complete GST determination engine.
Operators must select the applicable treatment. Special valuation, alternative tax
bases, tax-inclusive prices, multi-currency, automated place-of-supply determination,
credit/debit notes, statutory filing/e-invoicing and PDF rendering are not implemented.
They require separate workflows and business decisions before use where applicable.

Issuance locks the invoice and relevant master data, verifies the draft version and
rate selection, then allocates `I/2627/000001` from a transaction-protected company /
financial-year / document-kind counter. A changed tax selection or rate requires
saving and reviewing the draft again. Issue retries return the already issued
invoice. No `MAX(number)+1` query is used and cancelled numbers are never reused.

Company, customer, linked guest, service classification and selected bank details are
snapshotted whenever a draft is saved. Issuance freezes that reviewed snapshot. Lines
retain tax components, rate IDs, exact rates and amounts. Detail responses expose this
array as `appliedTaxes` and retain `taxes` as a compatibility alias. Later master
changes cannot alter the issued document. API mutations enforce immutability;
production database credentials must not be exposed to clients.

## Receipts and settlement discounts

Payments may be dated before the linked issued invoice's date. Receipts retain
the actual payment date, which determines their financial year and number series.

`POST /receipts` requires an `Idempotency-Key` header (8–128 letters, digits,
underscores, colons or hyphens). Example:

```json
{
  "invoiceId": "INVOICE_UUID",
  "receivedDate": "2026-08-21",
  "amount": "1000.00",
  "method": "UPI",
  "details": { "reference": "PAYMENT_REFERENCE" },
  "status": "CONFIRMED"
}
```

| Method      | Details                                                          |
| ----------- | ---------------------------------------------------------------- |
| CASH        | Empty object                                                     |
| CHEQUE / DD | reference, bankName, instrumentDate                              |
| CARD        | reference and cardLastFour; no full card number or security code |
| UPI         | reference                                                        |

A receipt starts PENDING or CONFIRMED. `POST /receipts/:id/confirm` confirms a pending
payment; admin-only `POST /receipts/:id/reverse` requires a reason. Only confirmed
receipts reduce due. Multiple receipts are supported. Invoice row locks serialize
settlements and confirmations, so concurrent requests cannot overpay an invoice.
Same-key/same-body retries return the original record; different content returns 409.
Receipt numbers use the separate `R/2627/000001` counter. Advance payments and
unallocated overpayments are not supported by this invoice-linked workflow.

An admin can record an explicitly understood **commercial settlement discount** with
`POST /settlement-adjustments` (invoiceId, amount, reason, date and Idempotency-Key).
`POST /settlement-adjustments/:id/reverse` reverses it with a reason. It is stored
separately from cash and never recalculates invoice tax.

For issued invoices: due = grand total - confirmed receipts - active settlement
adjustments. Draft/cancelled invoices have no receivable and report NOT_APPLICABLE.
Other payment states are UNPAID, PARTIALLY_PAID and PAID.

## Reports

Staff gateway review is available through internal UUID routes:
`GET /payment-orders/:orderId/review` (all Core read roles),
`POST /payment-attempts/:attemptId/resolve` (Core Admin only, idempotency key and
review version required), and `POST /payment-orders/:orderId/reconcile-by-id`
(Core write roles). The existing `/reconcile` routes still use provider references.
See [PAYMENT_REVIEW_API.md](PAYMENT_REVIEW_API.md) for full contracts, evidence rules,
refund attestation limits and migration `0026_aberrant_gladiator.sql`.

- `GET /reports/dashboard` — financial cards, mix breakdowns, current ageing, top
  debtors, payment methods, monthly trend, recent activity and configuration alerts.
- `GET /reports/invoices` — filtered invoice register with full-result totals.
- `GET /reports/vehicle-invoices` — vehicle-grouped invoice and settlement totals.
- `GET /reports/taxes` — applied-tax detail with component/rate/category breakdowns.
- `GET /reports/payments-received` — receipt-date report and status totals; all receipt
  states when `status` is omitted (`status=CONFIRMED` preserves the previous default).
- `GET /reports/payments` — unified staff-only manual receipts and gateway orders,
  with linked-receipt deduplication and independent receipt/gateway status fields.
- `GET /reports/receivables` — current receivables, payment state and ageing buckets.
- `GET /reports/settlement-discounts` — active and reversed commercial discounts.
- `GET /reports/customers/:id/statement` — invoice-linked customer statement.
- `GET /reports/audit` — Core Admin-only audit activity.
- `GET /guests/:id/activity` — most recent issued invoice linked to the guest and most
  recent confirmed receipt against such an invoice. Imported standalone last-service /
  last-amount values are returned separately; they are not fabricated transactions.

Tabular report endpoints accept the allow-listed filters and sorting documented in
OpenAPI and return `data`, full-filter `summary`, `pagination` and `meta`. The default
date period is the current financial year, except the unified `/reports/payments`,
which defaults to all history and uses payment activity dates in `Asia/Kolkata`.
Append `/export` to any tabular report or
customer statement path for a CSV export using the same filters; exports are capped
at 100,000 rows and never silently truncated. See `CORE_REPORTS_ANALYTICS_SPEC.md`
for calculation and date-basis definitions.

See [FRONTEND_UNIFIED_PAYMENTS_REPORT.md](FRONTEND_UNIFIED_PAYMENTS_REPORT.md) for
the exact unified contracts, filters, status values, accounting definitions and CSV
columns. Apply `0025_young_penance.sql` for receipt-link lookup indexes.

Receivables are current-state balances. Arbitrary historical as-of balances are not
offered because receipt status-transition history is not yet sufficient to
reconstruct them safely.

## Historical data and import

Do not run legacy records through new invoice issuance: that would allocate new
numbers and apply current configuration. The separate operational importer accepts
one normalized issued invoice JSON file and preserves the supplied line taxes,
rounding, header totals, printed party/bank snapshots and invoice number.

```sh
npm run core:invoice:import -- normalized-invoice.json --validate
CORE_IMPORT_ACTOR_ID=CORE_ADMIN_UUID npm run core:invoice:import -- normalized-invoice.json --apply
```

The interchange schema is `src/modules/core/legacy/invoice-import.schema.ts`.
`--validate` checks format and recorded totals without connecting to the database.
`--apply` additionally requires valid existing core master references and an active
core administrator. It atomically stores the invoice, lines, tax amounts, audit
record and legacy mapping. It never emits a new-issue event. Source/table/ID keys
make retries idempotent; changed source content is a conflict rather than an overwrite.

Historical rates need not match current rate tables. A missing historical rate ID
remains null. Missing structured supply-state/country can be null in this import
format. Historical issue time is not known: the timestamp is the start of the
invoice date in India, explicitly marked `issuanceTimeKnown: false` in the snapshot.
Only use the invoice date for historical reporting. Raw source data stays in the
restricted import mapping, outside HTTP responses.

Import requirements and reconciliation:

1. Inspect actual exports and prepare reviewed customer/agent crosswalks. Do not merge
   records by name alone. `core.legacy_mappings` can retain multiple source IDs for a
   consolidated entity. The current invoice command does not import masters or create
   this customer crosswalk automatically.
2. Create/link master records and preserve original field values and identifiers.
   Unknown enrichment fields stay null. Hotel plan columns map to individual rate
   records with the original validity end date.
3. Normalize issued invoices to the interchange format, using the historical printed
   values for snapshots, never current party/bank details.
4. Validate all recorded line/header totals. Discrepancies fail validation without
   recomputation; keep the raw export and resolve them in staging.
5. Import into a staging database, compare counts, invoice numbers, totals and printed
   values, and reconcile receipts and outstanding balances before production cutover.

Historical receipts and their discounts are **not imported by this command**. Their
meaning has not been established from the supplied invoice. Do not interpret old
receipt discounts as either new settlement discounts or tax corrections until the
export/calculation rules are reviewed. An invoice-only import initially has its full
amount outstanding; it must not be used as the production receivables ledger until
historical settlements are imported and reconciled. Actual legacy export adapters,
receipt import, cancelled historical invoice import and password migration remain
follow-up migration work once representative exports are available.

## Deployment and validation

`drizzle/0016_core_api.sql` is additive to existing feedback data: it adds the core
schema and scoped identity roles/username. Apply it using the repository's existing
migration job before deploying the new application. No production database is
modified by development tests. Existing configuration and session cleanup continue
to apply. No additional runtime packages or services are required.

Validation commands:

```sh
npm run check
# With a disposable migrated PostgreSQL database:
TEST_DATABASE_URL=postgresql://... npm test
```

Tests cover the supplied invoice arithmetic, tax precedence/ambiguity, rounding,
module boundaries, legacy preservation, role isolation, master version conflicts,
concurrent numbering and receipts, snapshot immutability, payment transitions,
settlement reversals, user session revocation and existing feedback workflows.

## Customer account access

See [CUSTOMER_ACCOUNTS_API.md](CUSTOMER_ACCOUNTS_API.md) for the customer namespace,
Core-admin invitation/membership endpoints, independent customer sessions, and
private-link compatibility. Customer accounts do not grant Core staff access.

### Payment attempts and reconciliation

Gateway orders have `CREATING`, `READY`, `PAID`, `EXPIRED`, `TERMINATED`, or
`REVIEW_REQUIRED` status. Each provider payment ID has a separate attempt record:
`NOT_ATTEMPTED`, `PENDING`, `SUCCESS`, `FAILED`, `USER_DROPPED`, `CANCELLED`, `VOID`,
or `UNKNOWN`. Unknown provider values retain their raw status and stay unresolved.
Attempt accounting status is `UNAPPLIED`, `APPLIED`, or `REVIEW_REQUIRED`. Failed
attempts do not fail the order or affect invoice balances.

All reconciliation endpoints preserve the existing `status` field and add
`orderStatus`, `latestAttemptStatus`, `accountingStatus`, `hasUnresolvedAttempts`,
`canRetry`, and `lastCheckedAt` (ISO timestamp or null). Staff and private-link
responses also contain `receiptId`; customer account responses do not expose
internal receipt IDs or gateway failure details. `status` can now be `FAILED`,
`USER_DROPPED`, `CANCELLED`, `VOID`, `NOT_ATTEMPTED`, `EXPIRED`, or `TERMINATED`,
in addition to `PENDING`, `PAID`, and `REVIEW_REQUIRED`. Clients must not interpret
all non-PAID states as pending. `canRetry` means a new payment may be attempted;
an expired/terminated order requires requesting a new checkout through the existing
checkout endpoint. Fetch current booking details to check the current amount due.

Staff booking detail adds `attempts` (including failure and accounting details) and
`reconciliation` (next check, lease, retry count and last safe error code). Order
metadata includes provider status, expiry, last check and `reviewRequiredAt`.
The existing public `paymentReviewRequired` flag also covers stuck payments and
additional successful attempts needing staff attention.

Checkout verifies existing unresolved orders before reusing a session or replacing
an expired order. Pending/unknown attempts block checkout with
`PAYMENT_ATTEMPT_PENDING`; unresolved accounting blocks with
`PAYMENT_REVIEW_REQUIRED`. An expired session still reported active by the provider
returns `PAYMENT_ORDER_UNAVAILABLE` until verified. A provider outage returns an
error and preserves the last known state; it never becomes a payment failure.

The worker polls due jobs one at a time. Checks occur approximately every minute
for the first five minutes, every five minutes until thirty minutes, every fifteen
minutes until two hours, hourly until one day, then daily. Failures use exponential
backoff capped at one hour. Pending/unknown outcomes continue indefinitely and are
flagged for review after `PAYMENT_PENDING_REVIEW_AFTER_HOURS` (default 24). Ten
consecutive reconciliation failures also flag the order. Closed orders are checked
daily until `PAYMENT_CLOSED_RECHECK_DAYS` (default 7) days after creation; callbacks
and manual reconciliation can reactivate checks afterward. Accounting review is
not automatically cleared; refunds and staff accounting resolution remain separate
reviewed workflows.

Jobs use two-minute leases, skip locked rows and fence completion with lease tokens.
New callbacks/manual checks increment a revision so a running worker cannot erase
newly requested work. Receipt creation, attempt application and order completion
commit together. Older observations cannot overwrite newer ones, and a verified
success cannot be downgraded by a subsequent pending/failed observation.

## Structured commercial billing

Structured quote versions, proposed plans, versioned private acceptance, billing review and transactional payment enablement are documented in [COMMERCIAL_BILLING_API.md](COMMERCIAL_BILLING_API.md), including frontend TypeScript contracts, JSON examples and migration rollout. Existing manual billing remains supported.
