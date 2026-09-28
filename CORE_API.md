# Eastern Risen core API

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

`POST /api/v1/auth/core/login` accepts `username` and `password` and uses the existing
secure session-cookie infrastructure. `/api/v1/auth/me` and `/logout` are shared.
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

- `GET /reports/dashboard` — financial cards, mix breakdowns, current ageing, top
  debtors, payment methods, monthly trend, recent activity and configuration alerts.
- `GET /reports/invoices` — filtered invoice register with full-result totals.
- `GET /reports/vehicle-invoices` — vehicle-grouped invoice and settlement totals.
- `GET /reports/taxes` — applied-tax detail with component/rate/category breakdowns.
- `GET /reports/payments-received` — receipt-date report and status totals.
- `GET /reports/receivables` — current receivables, payment state and ageing buckets.
- `GET /reports/settlement-discounts` — active and reversed commercial discounts.
- `GET /reports/customers/:id/statement` — invoice-linked customer statement.
- `GET /reports/audit` — Core Admin-only audit activity.
- `GET /guests/:id/activity` — most recent issued invoice linked to the guest and most
  recent confirmed receipt against such an invoice. Imported standalone last-service /
  last-amount values are returned separately; they are not fabricated transactions.

Tabular report endpoints accept the allow-listed filters and sorting documented in
OpenAPI and return `data`, full-filter `summary`, `pagination` and `meta`. The default
date period is the current financial year. Append `/export` to any tabular report or
customer statement path for a CSV export using the same filters; exports are capped
at 100,000 rows and never silently truncated. See `CORE_REPORTS_ANALYTICS_SPEC.md`
for calculation and date-basis definitions.

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
