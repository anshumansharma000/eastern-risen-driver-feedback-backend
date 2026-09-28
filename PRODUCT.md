# Eastern Risen Core API — Product Source of Truth

**Product:** Eastern Risen Core API

**Contract version:** v1

**Implementation status:** Current repository implementation

**Last verified:** 2026-09-08

**Owner:** Eastern Risen Core product and engineering team

## 1. Authority and purpose

This document is the canonical product specification for the Eastern Risen Core API. It defines the product boundary, users, permissions, domain language, data ownership, HTTP surface, business rules, lifecycle rules, financial calculations, operational requirements, migration behavior, and explicit non-goals.

The runtime API is served under `/api/v1/core`, with the three shared session endpoints listed in this document under `/api/v1/auth`. No other API surface belongs to this specification.

When sources disagree, resolve the discrepancy in this order:

1. This document defines intended product behavior.
2. The generated OpenAPI document at `/docs` defines the deployed wire contract.
3. `src/modules/core/http/*.routes.ts` and `*.schemas.ts` define route registration and validation.
4. `src/modules/core/domain` and `src/modules/core/persistence` define implemented business behavior and storage invariants.
5. Tests define verified examples, not new product behavior.

Any behavior change must update this document, the implementation, OpenAPI schemas, and relevant tests in the same change. If the implementation temporarily differs from this document, treat that difference as a defect or record it explicitly here as a known deviation.

This is a Core-only document. It intentionally does not specify adjacent product endpoints, workflows, roles, data models, or configuration.

## 2. Product definition

The Core API is the operational and financial system of record for Eastern Risen's travel-services business. It enables authorized staff to:

- maintain issuing companies and their bank accounts;
- maintain billing customers, travellers, hotels, hotel rates, service categories, and tax rules;
- access and maintain the shared vendor and vehicle catalog through controlled adapters;
- store Core-specific vendor and vehicle profile data without duplicating shared catalog ownership;
- prepare, calculate, review, issue, and cancel invoices;
- record, confirm, and reverse invoice-linked receipts;
- record and reverse commercial settlement discounts;
- view live receivables and traveller activity;
- administer Core users and access;
- import reviewed historical invoices without applying current issuance rules;
- preserve audit history and transactional domain events.

### 2.1 Product goals

- One trusted ledger for Core invoices, receipts, adjustments, and outstanding balances.
- Reproducible financial results using exact decimal arithmetic and immutable issued-document snapshots.
- Safe concurrent operation for document numbering, versioned edits, and settlement.
- Least-privilege access for administrators, data-entry operators, and report viewers.
- Preservation of historical printed values and source identity during migration.
- A module boundary that can later be extracted into a separately deployed service without changing the public v1 contract.

### 2.2 Primary users

| User | Primary outcomes |
| --- | --- |
| Core administrator | Configure legal, tax, service, banking, user, and lifecycle controls; perform exceptional actions such as cancellation and reversal. |
| Core data-entry operator | Maintain operational masters, prepare and issue invoices, and record or confirm receipts. |
| Core report viewer | Read Core data, invoice details, receivables, and traveller activity without changing records. |
| Migration operator | Validate and apply normalized historical invoices through an offline operational command. |
| API client | Integrate a trusted staff UI or internal system using the documented session, validation, idempotency, and response contracts. |

## 3. Scope and explicit non-goals

### 3.1 In scope now

- Cookie-based Core authentication and role authorization.
- Core user provisioning and administration.
- Ten dedicated Core master resources.
- Shared vendor and vehicle catalog access through ports/adapters.
- INR invoice calculation and issuance.
- Configured IGST, CGST, and SGST application selected by an operator.
- Import-only preservation of legacy service tax.
- Invoice-linked receipts and settlement discounts.
- Current receivables and guest activity reporting.
- Audit records and a transactional outbox.
- Normalized historical issued-invoice import.

### 3.2 Not implemented

The following are not capabilities of v1 and must not be implied by a client:

- automatic GST liability, tax treatment, or place-of-supply determination;
- GST returns, statutory filing, e-invoicing, IRN, e-way bills, or compliance certification;
- tax-inclusive pricing, alternate valuation bases, or special tax regimes;
- multiple currencies or currency conversion;
- mixed service categories within one invoice;
- quotations, pro-forma invoices, purchase orders, credit notes, or debit notes;
- invoice PDF generation, email delivery, or messaging delivery;
- recurring invoices or automated payment collection;
- advance payments, customer credit balances, or unallocated overpayments;
- partial allocation of one receipt across multiple invoices;
- refunds or bank reconciliation;
- inventory, itinerary execution, booking operations, payroll, or general ledger accounting;
- hard deletion of Core business records;
- company-scoped tenancy or per-company role membership;
- one account holding multiple roles or simultaneous module memberships;
- public or customer self-service access;
- outbox delivery to an event broker;
- master-data bulk import, historical receipt import, or historical cancelled-invoice import.

New work in any of these areas requires an explicit product decision, data model, permission model, migration plan, API contract, and tests.

## 4. System and ownership boundaries

The product currently runs as a module in one Fastify application and one PostgreSQL database. Core-owned tables live in the dedicated `core` schema.

```text
HTTP /api/v1/core
        |
        v
Core HTTP and access layer
        |
        v
Core application contracts
     /      \
    v        v
Core domain  Core persistence (`core` schema)
                 |
                 +--> audit events
                 +--> transactional outbox

External ports:
  Core identity --> shared account/session implementation
  Shared catalog --> vendor and vehicle services
```

### 4.1 Module responsibilities

| Module | Responsibility |
| --- | --- |
| `src/modules/core/domain` | Money arithmetic, tax selection, receipt rules, outstanding balance, date and financial-year rules. No HTTP or database dependency. |
| `src/modules/core/application` | Transport-independent inputs and identity/catalog ports. |
| `src/modules/core/persistence` | Core schema, repositories, transactions, locks, counters, snapshots, audit, reports, and outbox writes. |
| `src/modules/core/http` | Route registration, TypeBox request/response schemas, role guards, public projections, and database-error translation. |
| `src/modules/core/legacy` | Strict historical invoice interchange validation and ingestion. |
| `src/modules/core/index.ts` | Core composition and route registration. |

An architecture test prevents Core from importing other product modules or the shared application schema directly.

### 4.2 Record ownership

- Core exclusively owns companies, bank accounts, customers, guests, hotels, hotel rates, service categories, tax rules, Core profiles, invoices, invoice lines, applied taxes, counters, receipts, settlement adjustments, audit events, outbox events, and legacy mappings.
- Shared identity owns accounts, password hashes, and sessions. Core accesses identity through `CoreIdentity`.
- The shared catalog owns vendor name/contact data and vehicle registration/display data. Core accesses it through `SharedCatalog`.
- Core vendor and vehicle profiles own only the additional fields listed in section 8.
- External account, vendor, and vehicle IDs deliberately do not have cross-module foreign keys. Identity and catalog references are validated through adapters where the operation requires it.
- Creating a catalog vendor or vehicle and creating its optional Core profile are two distinct operations. There is no cross-service transaction.

### 4.3 Extraction contract

Future service extraction must preserve `/api/v1/core` behavior. Extraction consists of moving the module and Core schema, replacing local identity/catalog adapters with authenticated clients or a shared identity provider, restricting database credentials to owned schemas, adding reliable outbox publication, and routing the existing prefix to the extracted service.

## 5. HTTP contract conventions

### 5.1 Base paths

- Core resources: `/api/v1/core`
- Core login and shared session actions used by Core: `/api/v1/auth`
- Interactive OpenAPI: `/docs` in non-production environments by default
- Readiness: `/health` is application infrastructure, not a Core business resource

### 5.2 Media type and naming

- Request and response bodies are JSON unless the response is HTTP 204.
- JSON fields use `camelCase`.
- IDs are UUID strings.
- Calendar dates are ISO `YYYY-MM-DD` strings.
- Timestamps are ISO date-time strings.
- Unknown request properties are rejected on Core request bodies.
- User-supplied identifiers in URLs must be safely encoded by clients.

### 5.3 Success envelopes

Single resource:

```json
{ "data": { "id": "..." } }
```

Collection:

```json
{
  "data": [],
  "pagination": { "page": 1, "pageSize": 25, "total": 0 }
}
```

HTTP 204 responses have no body.

### 5.4 Pagination and filtering

- `page`: integer 1–1,000,000; default 1.
- `pageSize`: integer 1–100; default 25.
- Dedicated master lists accept optional `status`.
- Customer lists additionally accept `category` and `q`.
- `q` is a literal, case-insensitive substring search used for the billing customer picker.
- Invoice, catalog, user, and report lists currently support pagination only; clients must not invent unimplemented filters or sorting parameters.

### 5.5 Error envelope

```json
{
  "error": {
    "code": "CORE_VALIDATION_FAILED",
    "message": "Safe user-facing message",
    "developerMessage": "Optional technical guidance",
    "details": {},
    "requestId": "request-correlation-id"
  }
}
```

All responses include `x-request-id`; error bodies also contain `requestId`. Standard error statuses are 400, 401, 403, 404, 409, 413, 415, 422, 429, 500, and 503.

Important Core error codes include:

| Code | Status | Meaning |
| --- | --- | --- |
| `REQUEST_VALIDATION_FAILED` | 400 | Body, path, query, or header schema failed. `details.fields` may identify fields. |
| `CORE_ACCESS_REQUIRED` | 403 | Authenticated account lacks a permitted Core role. |
| `CORE_NOT_FOUND` / `CORE_USER_NOT_FOUND` | 404 | Requested Core resource or user does not exist. |
| `STALE_VERSION` | 409 | Optimistic concurrency version is no longer current. |
| `INVOICE_IMMUTABLE` | 409 | Attempted to edit a non-draft invoice. |
| `INVALID_INVOICE_STATE` / `INVOICE_NOT_ISSUED` | 409 | Lifecycle transition is not allowed. |
| `OVERPAYMENT` | 409 | Settlement exceeds current outstanding balance. |
| `IDEMPOTENCY_CONFLICT` | 409 | Key was already used with different content. |
| `TAX_RULE_OVERLAP` | 409 | Active rule periods overlap for the same component and service scope. |
| `LAST_CORE_ADMIN` | 409 | Operation would remove the final active Core administrator. |
| `NUMBER_SERIES_EXHAUSTED` | 409 | Six-digit document counter is exhausted. |
| `CORE_RECORD_CONFLICT` | 409 | A unique identifier already exists. |
| `CORE_VALIDATION_FAILED` | 422 | Business validation failed. |
| `CORE_REFERENCE_INVALID` | 422 | Reference is missing or still in use. |
| `CORE_CONSTRAINT_FAILED` | 422 | A Core database constraint rejected the operation. |
| `CORE_DATABASE_ERROR` | 503 | Persistence failed without a more specific safe translation. |

Clients must show the safe `message`, preserve the request ID for support, and never expose SQL, stack traces, or raw internal errors.

## 6. Authentication, sessions, and authorization

### 6.1 Session API

| Method | Path | Access | Contract |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/core/login` | Public; 5 attempts/minute | `{username,password}` → `{data:{user,expiresAt}}` and session cookie |
| GET | `/api/v1/auth/me` | Authenticated | `{data:{user}}` |
| POST | `/api/v1/auth/logout` | Any current session | Revokes session, clears cookie, returns 204 |

The principal is:

```json
{
  "accountId": "UUID",
  "role": "CORE_ADMIN",
  "displayName": "Core Administrator",
  "driverId": null
}
```

Core login uses username, not email. Usernames are case-insensitively unique and must contain 3–64 ASCII letters, digits, underscore, period, or hyphen when created or updated. Emails are globally unique. Login accepts a 1–128 character password so existing hashes can be verified; newly set passwords require 12–128 characters.

### 6.2 Cookie behavior

- Session tokens are opaque and stored in an HttpOnly cookie; there is no bearer/JWT contract.
- Development: `SameSite=Lax`.
- Production: `Secure`, `SameSite=None`, and `Partitioned`.
- Cookie path is `/`.
- Default idle lifetime is 72 hours, absolute lifetime 30 days, rotation interval 24 hours, and rotation grace 60 seconds; deployments may configure these values.
- Authorized browser clients send `credentials: include` and must originate from an exact configured frontend origin.
- Session access changes and password resets revoke the affected user's sessions.

### 6.3 Roles

| Role | Meaning |
| --- | --- |
| `CORE_ADMIN` | Full Core read/write/configuration/user access and exceptional financial actions. |
| `CORE_DATA_ENTRY` | Operational master, catalog, draft, invoice issue, and receipt entry access. |
| `CORE_REPORT_VIEWER` | Read-only Core access. |

One account has one role. Roles are installation-wide and are not scoped to a company.

### 6.4 Permission matrix

| Capability | Admin | Data entry | Report viewer |
| --- | :---: | :---: | :---: |
| Read all Core masters, catalog records, invoices, details, and reports | Yes | Yes | Yes |
| Create/update companies and bank accounts | Yes | No | No |
| Create/update service categories and tax rules | Yes | No | No |
| Create/update customers, guests, hotels, hotel rates, and Core profiles | Yes | Yes | No |
| Create/update shared vendors and vehicles | Yes | Yes | No |
| Change shared vendor/vehicle lifecycle status | Yes | No | No |
| Create/update invoice drafts and issue invoices | Yes | Yes | No |
| Create and confirm receipts | Yes | Yes | No |
| Cancel invoices | Yes | No | No |
| Reverse receipts | Yes | No | No |
| Create/reverse settlement discounts | Yes | No | No |
| Create/list/update users, change access, reset passwords | Yes | No | No |

Backend authorization is authoritative; a client must also hide or disable unavailable actions.

### 6.5 Administrator bootstrap

```sh
export CORE_ADMIN_USERNAME=core-admin
export CORE_ADMIN_EMAIL=admin@example.com
export CORE_ADMIN_DISPLAY_NAME='Core Administrator'
read -s CORE_ADMIN_PASSWORD
export CORE_ADMIN_PASSWORD
npm run core:admin:create
unset CORE_ADMIN_PASSWORD
```

Passwords use Argon2id. The last active Core administrator cannot be disabled, archived, or moved to another role.

## 7. Shared value rules

### 7.1 Money

- API money values are decimal strings matching `^(0|[1-9][0-9]{0,11})\.[0-9]{2}$`.
- They always contain exactly two fractional digits, have at most 12 integer digits, and are nonnegative at the shared parser boundary.
- Business objects requiring positive values, including receipts and settlement discounts, reject `0.00`.
- Core v1 currency is INR only.
- The domain converts values to integer paise using `BigInt`; binary floating-point is never used for financial arithmetic.

### 7.2 Tax rates

- Rates are decimal strings from 0 through 100 with up to four fractional digits.
- Tax is rounded half-up to paise for each invoice line and tax component.
- Header totals are sums of already rounded line/component values.

### 7.3 Text, dates, and nulls

- Required `nonblank` fields must contain at least one non-whitespace character and are capped at 2,000 characters unless a narrower field limit is stated.
- Optional master text accepts a string up to 4,000 characters or `null`.
- Omitted optional fields on a create become null/default as applicable.
- A master `PUT` is a full replacement: omitted optional fields clear to null and omitted `status` becomes `ACTIVE`.
- Date ranges are inclusive and an end date cannot precede its start date.

### 7.4 Core master metadata

Every dedicated Core master returns:

```text
id, status, version, createdAt, updatedAt
```

- Status: `ACTIVE`, `INACTIVE`, or `ARCHIVED`.
- Version starts at 1 and increments on each successful update.
- Every `PUT` requires the version from the latest read.
- Stale updates return HTTP 409.
- No Core master has a DELETE endpoint.

## 8. Domain model and field dictionary

### 8.1 Company

The legal issuing entity. Fields: `name` (required), `address`, `phone`, `mobileNumber`, `email`, `pan`, `serviceTaxNumber`, `cin`, `gstNumber`, `website`, `state`, `country`, `postalCode`, `branchOffice`, `paymentInstructions`, and `footerNotes`.

Unknown address/state/country may remain null during migration, but an active company must have usable identity and supply data before new invoice issuance. Selected company data is snapshotted when an invoice is issued.

### 8.2 Bank account

A company-owned payment destination. Fields: `companyId`, `name`, `accountNumber` (all required), `branch`, `ifscCode`, and `swiftCode`. Account numbers are strings and must not be converted to numbers. An invoice may select zero to ten unique active accounts belonging to its company; selected values are snapshotted at issue.

### 8.3 Customer

The party that owes the invoice. Fields: `name`, `category` (required), `address`, `city`, `state`, `country`, `postalCode`, `phone`, `mobileNumber`, `email`, `contactPerson`, `pan`, `serviceTaxNumber`, `gstNumber`, and `market`.

- Category: `AGENT`, `LEISURE`, or `CORPORATE`.
- Market: `DOMESTIC`, `INTERNATIONAL`, or null.
- Market classification does not select a currency.

### 8.4 Guest

An optional structured traveller related to an invoice. Fields: `name` (required), address/contact fields, `market`, `legacyLastServiceAvailed`, and `legacyLastAmountPaid`.

`guestId` is optional on an invoice, while `guestDisplayText` is always required. This permits group or historical text without inventing individual guest records. Legacy last-service/payment fields are informational migration attributes and are never fabricated as invoices or receipts.

### 8.5 Hotel

A hotel master with `name` (required), address/contact fields, and optional `market`. It is reference data; v1 invoices do not directly reference a hotel ID.

### 8.6 Hotel rate

A named commercial hotel rate. Fields: `hotelId`, `plan`, `amount`, `currency`, `name` (required), `effectiveFrom`, and `effectiveTo`.

- Plans: `APAI`, `MAPAI`, `CPAI`.
- Currency: literal `INR`.
- Amount is nonnegative.
- Both dates may be null to preserve incomplete historical data; when present, the end cannot precede the start.
- Hotel rates are reference data and are not automatically priced into an invoice.

### 8.7 Service category

The invoice-wide service classification. Fields: `name` and `code`, both required. `code` preserves HSN/SAC or other service classification text and must remain a string.

Expected business categories include Advertisement, Air ticket, Car Service, Hotel Booking, Itinerary, MICE, Service charge, Train ticket, and Travel Service. These names are setup guidance, not an automatic seed or closed enum. No tax rate or classification code is assumed.

### 8.8 Tax rule

An effective-dated rate for one tax component and either one service category or all service categories.

Fields: `name`, `component`, `serviceCategoryId`, `rate`, `effectiveFrom`, and `effectiveTo`.

- Components: `IGST`, `CGST`, `SGST`, `SERVICE_TAX`.
- `serviceCategoryId: null` means an all-services fallback.
- Effective dates are inclusive.
- Active periods may not overlap for the same component and same service scope.
- A category-specific rule takes precedence over the all-services rule.
- `SERVICE_TAX` is historical/import-only and cannot be selected on a new invoice.

### 8.9 Shared vendor

Catalog-owned fields: `name` (required, 1–200), `contactName`, `contactEmail`, and `contactPhone`. Responses add `id`, `status`, `createdAt`, `updatedAt`, and nullable `archivedAt`.

Catalog status is `ACTIVE`, `DEACTIVATED`, or `ARCHIVED`; it is intentionally different from Core master status. Catalog updates do not use Core `version` concurrency.

### 8.10 Core vendor profile

One optional profile per external `vendorId`. Fields: `address`, `city`, `state`, `country`, `postalCode`, `mobileNumber`, and `market`. Do not copy catalog-owned name, email, general phone, or contact-person fields into this profile.

### 8.11 Shared vehicle

Catalog-owned fields: `registrationNumber` (required, 1–64) and `displayName` (required, 1–200), plus catalog metadata and status. Catalog updates do not use Core `version` concurrency.

### 8.12 Core vehicle profile

One optional profile per external `vehicleId`. Fields: `vehicleType`, `registeredOwner`, `address`, `contactNumber`, `accountNumber`, `ifscCode`, and `bankName`. Banking fields are restricted operational data and must not be logged or copied into general catalog records.

### 8.13 Core user

Safe API projection: `id`, `username`, `email`, `displayName`, `role`, and `status`. Password hashes and session details are never returned.

### 8.14 Invoice aggregate

An invoice contains the following header concepts:

- references: `companyId`, `customerId`, optional `guestId`, `serviceCategoryId`;
- display/context: `guestDisplayText`, optional `passengerCount`, `serviceProvidedAt`, `placeOfSupplyState`, `placeOfSupplyCountry`, optional `label`;
- dates: `invoiceDate`, optional `dueDate`;
- payment display: up to ten unique `bankAccountIds`;
- one to 200 ordered lines;
- calculated `subtotal`, `taxTotal`, and `grandTotal`;
- lifecycle `status`, `version`, optional `financialYear`, optional `invoiceNumber`, issue/cancellation timestamps and reason;
- immutable issue `snapshot`;
- creator and creation/update timestamps.

Each line has `position`, `description`, base `amount`, `taxTreatment`, `taxAmount`, `total`, and applied tax records containing component, exact rate, calculated amount, and optional rule ID.

### 8.15 Receipt

An invoice-linked payment record with `invoiceId`, derived `companyId`, allocated `receiptNumber`, `financialYear`, `receivedDate`, `amount`, `method`, method-specific `details`, `status`, creator/timestamps, and optional `reversalReason`.

### 8.16 Settlement adjustment

An explicitly authorized commercial discount against an issued invoice. Fields: `invoiceId`, `amount`, `reason`, `date`, creator/creation time, and optional reversal time/reason. It is not cash, a tax correction, a credit note, or an invoice-total mutation.

## 9. Endpoint inventory

All paths in this section are relative to `/api/v1/core`. `R` means any Core role, `W` means admin or data entry, and `A` means Core admin only.

### 9.1 Dedicated masters

Every row below exposes the same four operations: `GET /resource` (R), `GET /resource/:id` (R), `POST /resource`, and `PUT /resource/:id`.

| Resource | Create/update access | Special list filters or rules |
| --- | --- | --- |
| `/companies` | A | `status`; issuer setup |
| `/bank-accounts` | A | `status`; account must reference a company |
| `/customers` | W | `status`, `category`, `q` |
| `/guests` | W | `status` |
| `/hotels` | W | `status` |
| `/hotel-rates` | W | `status`; validates period |
| `/service-categories` | A | `status` |
| `/tax-rules` | A | `status`; validates period and overlap |
| `/vendor-profiles` | W | `status`; one profile per external vendor |
| `/vehicle-profiles` | W | `status`; one profile per external vehicle |

`POST` returns 201. `GET` and `PUT` return 200. Updates require `version` and replace all editable fields.

### 9.2 Shared catalog

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/vendors` | R | Paginated vendor list |
| GET | `/vendors/:id` | R | Vendor detail |
| POST | `/vendors` | W | Create shared vendor |
| PUT | `/vendors/:id` | W | Replace shared vendor fields |
| PATCH | `/vendors/:id/status` | A | Set `ACTIVE`, `DEACTIVATED`, or `ARCHIVED` |
| GET | `/vehicles` | R | Paginated vehicle list |
| GET | `/vehicles/:id` | R | Vehicle detail |
| POST | `/vehicles` | W | Create shared vehicle |
| PUT | `/vehicles/:id` | W | Replace shared vehicle fields |
| PATCH | `/vehicles/:id/status` | A | Set catalog lifecycle status |

Core financial profiles are not embedded in catalog responses. Clients join them deliberately by ID when a screen needs both views.

### 9.3 User administration

All user endpoints require `CORE_ADMIN`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/users` | Paginated safe user list |
| POST | `/users` | Create `{username,email,displayName,password,role}`; returns 201 |
| PUT | `/users/:id` | Replace `{username,email,displayName}` |
| PATCH | `/users/:id/access` | Set `{role,status}` and revoke sessions |
| POST | `/users/:id/password-reset` | Set `{password}`, revoke sessions, return 204 |

### 9.4 Billing

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/invoices` | R | Paginated invoice summaries |
| GET | `/invoices/:id` | R | Full invoice, lines, taxes, receipts, adjustments, and current balance |
| POST | `/invoices` | W | Create calculated draft; returns 201 |
| PUT | `/invoices/:id` | W | Replace and recalculate a draft using `version` |
| POST | `/invoices/:id/issue` | W | Issue reviewed draft using `{version}` |
| POST | `/invoices/:id/cancel` | A | Cancel issued invoice using `{reason}` |
| POST | `/receipts` | W | Create pending or confirmed receipt; requires `Idempotency-Key`; returns 201 |
| POST | `/receipts/:id/confirm` | W | Confirm a pending receipt |
| POST | `/receipts/:id/reverse` | A | Reverse using `{reason}` |
| POST | `/settlement-adjustments` | A | Create commercial discount; requires `Idempotency-Key`; returns 201 |
| POST | `/settlement-adjustments/:id/reverse` | A | Reverse discount using `{reason}` |

There are no standalone receipt or adjustment list/detail endpoints. Their public read model is embedded in invoice detail.

### 9.5 Reports

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/reports/receivables` | R | Paginated issued invoices with total, received, adjusted, and due amounts |
| GET | `/guests/:id/activity` | R | Last issued service and last confirmed payment linked to the guest, plus legacy informational values |

## 10. Invoice calculation and lifecycle

### 10.1 Draft request

```json
{
  "companyId": "COMPANY_UUID",
  "customerId": "CUSTOMER_UUID",
  "guestId": null,
  "guestDisplayText": "Traveller X 04",
  "passengerCount": 4,
  "serviceCategoryId": "SERVICE_CATEGORY_UUID",
  "invoiceDate": "2026-08-20",
  "dueDate": "2026-08-30",
  "serviceProvidedAt": "ODISHA",
  "placeOfSupplyState": "ODISHA",
  "placeOfSupplyCountry": "INDIA",
  "label": null,
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

The server, never the client, is authoritative for applied rates and calculated totals.

### 10.2 Draft validation

- `companyId`, `customerId`, and `serviceCategoryId` must reference active records.
- Optional `guestId`, when supplied, must reference an active guest.
- `guestDisplayText`, `serviceProvidedAt`, `placeOfSupplyState`, and `placeOfSupplyCountry` are required and nonblank for new drafts.
- `passengerCount`, when supplied, is 1–100,000.
- `dueDate`, when supplied, cannot precede `invoiceDate`.
- `bankAccountIds` contains at most ten unique IDs, all active and owned by the invoice company.
- An invoice contains 1–200 lines.
- A taxable line must select tax components.
- A non-taxable, exempt, or nil-rated line cannot select tax components.
- The same component cannot appear twice on one line.
- IGST cannot coexist with CGST or SGST on the same line.
- CGST and SGST must be selected together.
- SERVICE_TAX cannot be selected for a new draft.
- Exactly one effective applicable rule must resolve for every selected component.

### 10.3 Tax lookup and calculation

For every taxable line/component:

1. Use `invoiceDate` as the tax effective date.
2. Find active rules whose inclusive period covers that date.
3. Prefer a rule for the invoice's service category.
4. If none exists, use an all-services rule with `serviceCategoryId: null`.
5. Require exactly one applicable rule; ambiguity or absence fails validation.
6. Calculate component tax from the line base amount and exact rule rate.
7. Round half-up to paise for that component on that line.

Then:

```text
line tax        = sum(rounded component tax amounts)
line total      = line amount + line tax
invoice subtotal = sum(line amounts)
invoice taxTotal = sum(line tax amounts)
invoice grandTotal = subtotal + taxTotal
```

At 5% IGST, `81500.00` produces `4075.00` tax and `85575.00` total.

### 10.4 State machine

```text
             issue
  DRAFT ----------------> ISSUED
    |                       |
    | edit/recalculate      | cancel (admin; no active settlements)
    v                       v
  DRAFT                  CANCELLED
```

- Drafts have no invoice number, financial year, issue timestamp, or snapshot.
- Only drafts are editable.
- Draft updates and issue commands require the current optimistic `version`.
- Issue is retry-safe: retrying issue on an already issued invoice returns it.
- Cancelled invoices cannot be reissued.
- Cancellation requires a nonblank reason.
- An invoice with any non-reversed receipt or settlement adjustment cannot be cancelled; reverse those records first.
- Issued and cancelled invoice numbers are never reused.

### 10.5 Issuance and numbering

Issuance runs in one transaction and locks the invoice plus relevant master state. It revalidates active references and tax selection, creates the immutable snapshot, and allocates the number from a transaction-protected counter scoped to:

```text
company + Indian financial year + document kind
```

Invoice format: `I/2627/000001`. Receipt format: `R/2627/000001`. Counters are independent, begin at 1, and end at 999999. Numbering never uses `MAX(existing number) + 1`.

The Indian financial year is derived from the document date: April–March. `2026-08-20` maps to `2627`; a January–March 2027 date also maps to `2627`.

### 10.6 Immutable snapshot

At issue, Core snapshots:

- schema version;
- complete selected company values;
- complete customer values;
- service category/classification;
- selected company bank accounts in request order;
- currency `INR`;
- rounding policy `HALF_UP_PER_LINE_COMPONENT`;
- tax effective date.

Lines preserve component, rule ID where available, rate, and calculated amount. Later master or tax-rule changes must not alter issued output.

## 11. Receipts, adjustments, and balances

### 11.1 Receipt creation

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

Receipts can only target an issued invoice and cannot exceed its locked current outstanding balance.

| Method | Required details | Forbidden/unneeded details |
| --- | --- | --- |
| `CASH` | Empty object | All payment detail fields |
| `CHEQUE` | `reference`, `bankName`, `instrumentDate` | `cardLastFour` |
| `DD` | `reference`, `bankName`, `instrumentDate` | `cardLastFour` |
| `CARD` | `reference`, four-digit `cardLastFour` | Bank/instrument fields; full card data |
| `UPI` | `reference` | Bank/instrument/card fields |

Never accept, store, or log full card numbers, security codes, PINs, or credentials.

Receipt states:

```text
PENDING --confirm--> CONFIRMED --reverse(admin)--> REVERSED
PENDING -----------------------reverse(admin)--> REVERSED
```

- Creation state is explicitly `PENDING` or `CONFIRMED`.
- Only confirmed receipts reduce outstanding balance.
- Confirming a confirmed receipt is idempotent.
- A reversed receipt cannot be confirmed.
- Reversal requires a nonblank reason.

### 11.2 Idempotency

Receipt and settlement-adjustment creation require `Idempotency-Key` with 8–128 ASCII letters, digits, underscores, colons, or hyphens.

- The key is globally unique within that record type in the current implementation.
- The transaction locks by key before lookup/create.
- Same key and same normalized request returns the original record.
- Same key and different content returns `IDEMPOTENCY_CONFLICT`.
- Clients should generate a new unpredictable key for each user-intended creation and retain it across retries after a timeout.

### 11.3 Settlement discount

Creation requires `{invoiceId, amount, reason, date}` and an idempotency key.

- Only a Core admin can create or reverse it.
- The invoice must be issued.
- Amount must be positive and cannot exceed current outstanding balance.
- Date cannot precede invoice date.
- Reversal requires a reason.
- An active adjustment reduces due but does not change invoice subtotal, tax, or grand total.
- An adjustment is recorded separately from receipts so reports never represent discount as collected cash.

### 11.4 Balance model

For an issued invoice:

```text
receivedAmount   = sum(CONFIRMED receipts)
adjustmentAmount = sum(non-reversed settlement adjustments)
dueAmount        = grandTotal - receivedAmount - adjustmentAmount
```

Payment status:

- `NOT_APPLICABLE`: invoice is draft or cancelled; due is `0.00`.
- `UNPAID`: issued, due is positive, and neither confirmed receipts nor active adjustments exist.
- `PARTIALLY_PAID`: issued, due is positive, and some receipt/adjustment has reduced it.
- `PAID`: issued and due is `0.00`.

Invoice row locks serialize receipt creation, confirmation, and adjustment creation, preventing concurrent overpayment.

## 12. Reporting read models

### 12.1 Receivables

`GET /reports/receivables` returns issued invoices only, with:

```text
invoiceId, invoiceNumber, companyId, customerId, invoiceDate,
grandTotal, receivedAmount, adjustmentAmount, dueAmount
```

Amounts are calculated from current settlement states. The endpoint supports the
date, party, category, vehicle, payment-status, ageing, due-date, search and sorting
filters defined in OpenAPI, returns full-filter summaries, and has a CSV export.

### 12.2 Financial reports and dashboard

Core provides a dashboard plus invoice-register, vehicle-wise invoice, applied-tax,
payments-received, settlement-discount, customer-statement and audit reports. Every
metric has an explicit invoice, receipt, adjustment or event date basis. Full
calculation, filter, sort, pagination, CSV and reconciliation requirements are in
`CORE_REPORTS_ANALYTICS_SPEC.md`.

Receivables and customer closing balances are current-state values. Historical
as-of balances require a future immutable receipt-status history and are not
represented by the current API.

### 12.3 Guest activity

`GET /guests/:id/activity` returns:

- the most recent issued invoice linked through `guestId`, including number, date, and line descriptions;
- the most recent confirmed receipt against an invoice linked to that guest;
- the guest's separately stored `legacyLastServiceAvailed` and `legacyLastAmountPaid` values.

Free-text `guestDisplayText` alone does not establish a guest relationship. Legacy summary fields are not converted into fabricated transactional history.

## 13. Audit and domain events

### 13.1 Audit trail

Core mutations write append-only audit events containing actor ID, action, entity type, entity ID, and timestamp. Audited operations include master creation/update, draft creation/update, issue/cancellation, receipt creation/status change, settlement creation/reversal, and Core user administration.

Core Admins can inspect the safe audit projection through `GET /reports/audit` and
its CSV export. It contains actor, action, entity identity and timestamp only; it does
not expose credentials, sensitive metadata or field-level before/after values.

### 13.2 Transactional outbox

The following versioned events are stored in `core.outbox` in the same transaction as the state change:

- `core.invoice.issued.v1`
- `core.invoice.cancelled.v1`
- `core.receipt.created.v1`
- `core.receipt.confirmed.v1`
- `core.receipt.reversed.v1`

Payloads contain identifiers rather than personal data or full financial snapshots. There is currently no publisher or consumer. A future publisher must mark `publishedAt` only after delivery acknowledgement; consumers must deduplicate by outbox event ID. Event contract changes require a new versioned event name.

Settlement-adjustment events are not currently emitted.

## 14. Security, privacy, and operational controls

- Production database transport must require TLS.
- Database credentials must never be exposed to clients; future deployments should restrict them to the Core-owned schema.
- Session cookies and Set-Cookie headers are redacted from logs.
- Password fields and configured personal fields are redacted from structured logs.
- Core clients must additionally avoid logging invoice bodies, guest/contact data, bank details, receipt details, snapshots, and idempotency keys.
- HTTP responses use Helmet security headers.
- Browser-origin protection is enforced against configured exact origins.
- Core login is rate limited to five attempts per minute.
- Default request timeout is 30 seconds and default body limit is 1 MiB, both configurable.
- Inputs and imported strings are data, never executable HTML or instructions.
- Response schemas whitelist public fields; password hashes, request hashes, idempotency storage, raw legacy records, and internal audit/outbox rows are not returned.
- Production interactive API docs are disabled by default.
- Graceful shutdown handles SIGINT/SIGTERM and closes the HTTP server and database pool within the configured deadline.

There is no current field-level encryption for Core bank or financial profile columns. Their protection depends on database encryption, access controls, backups, transport security, and restricted logging. Introducing application-level encryption requires a compatible migration and query strategy.

## 15. Historical invoice migration

Historical invoices must never be sent through new draft issuance because that would allocate new numbers and apply current rules.

### 15.1 Commands

```sh
npm run core:invoice:import -- normalized-invoice.json --validate
CORE_IMPORT_ACTOR_ID=CORE_ADMIN_UUID npm run core:invoice:import -- normalized-invoice.json --apply
```

The interchange contract is `src/modules/core/legacy/invoice-import.schema.ts`.

### 15.2 Guarantees

- `--validate` checks shape and recorded totals without connecting to PostgreSQL.
- `--apply` requires valid existing Core master references and an active Core admin actor.
- Apply stores the issued invoice, lines, component taxes, issue snapshot, audit record, and legacy mapping atomically.
- Supplied invoice number, printed party/bank data, tax values, rounding, and totals are preserved.
- No new-issue outbox event is emitted.
- `{source, sourceTable, sourceId}` makes import retries idempotent.
- Reusing a source key with different content is a conflict, never an overwrite.
- Missing historical rule IDs remain null.
- Missing historical structured supply fields may remain null.
- Unknown issue time is represented as the start of invoice date in India with `issuanceTimeKnown: false`; reports must rely only on the historical invoice date.
- Raw source data remains in restricted `legacy_mappings` and is not returned over HTTP.

### 15.3 Required migration process

1. Inspect representative source exports.
2. Build and review customer/agent crosswalks; never merge solely by name.
3. Create or link masters while preserving original identifiers and unknown values as null.
4. Normalize invoices using historical printed snapshots rather than current masters.
5. Reconcile every line and header total; do not silently recompute discrepancies.
6. Import into staging and compare record counts, invoice numbers, totals, and printed values.
7. Import and reconcile historical settlements through a separately approved process before treating imported invoices as the production receivables ledger.

The current importer does not import masters, customer crosswalks, receipts, legacy discounts, cancelled invoices, or passwords. An imported invoice with no imported settlement appears fully outstanding.

## 16. Deployment and configuration

### 16.1 Runtime

- Node.js 22.13 or later.
- Fastify 5 application.
- PostgreSQL through Drizzle ORM.
- Core schema migration: `drizzle/0016_core_api.sql`.
- Migration is additive and must run before deploying Core application code.

### 16.2 Core-relevant configuration

| Variable | Purpose / default |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection string. |
| `DATABASE_SSL_MODE` | Must require TLS in production. |
| `DATABASE_MAX_CONNECTIONS` | Pool maximum; default 10. |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Pool connection timeout; default 10,000. |
| `DATABASE_IDLE_TIMEOUT_MS` | Idle connection timeout; default 30,000. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Statement timeout; default 30,000. |
| `SESSION_COOKIE_NAME` | Opaque cookie name; default `id`. |
| `SESSION_IDLE_TTL_HOURS` | Default 72. |
| `SESSION_ABSOLUTE_TTL_DAYS` | Default 30. |
| `SESSION_ROTATION_INTERVAL_HOURS` | Default 24; must be less than idle TTL. |
| `SESSION_ROTATION_GRACE_SECONDS` | Default 60. |
| `FRONTEND_ORIGINS` | Required exact browser origins in production. |
| `TRUST_PROXY_HOPS` | Trusted proxy hop count; default 0. |
| `CONNECTION_TIMEOUT_MS` | HTTP connection timeout; default 10,000. |
| `REQUEST_TIMEOUT_MS` | Request timeout; default 30,000. |
| `KEEP_ALIVE_TIMEOUT_MS` | Keep-alive timeout; default 72,000. |
| `BODY_LIMIT_BYTES` | Request body limit; default 1,048,576. |
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown deadline; default 10,000. |
| `HOST` / `PORT` | Bind address `0.0.0.0`; port 3000 by default. |
| `LOG_LEVEL` | `debug` in development, `info` in production by default. |

Bootstrap command variables are listed in section 6.5. Import apply additionally requires `CORE_IMPORT_ACTOR_ID`.

### 16.3 Deployment order

1. Back up and verify the target database.
2. Apply repository migrations through the deployment migration job.
3. Provision the first Core admin through secure secret injection.
4. Deploy the application with production TLS, origin, session, logging, and database settings.
5. Verify health, Core login, `/auth/me`, role denial, one read endpoint, and a non-production financial workflow.
6. Restrict or disable interactive docs in production.

## 17. Verification and release gates

Run the complete repository gate:

```sh
npm run check
```

This runs formatting checks, linting, TypeScript checks, tests, and the production build. Database integration tests require a disposable migrated database:

```sh
TEST_DATABASE_URL=postgresql://... npm test
```

A Core release is not complete unless it verifies, in proportion to the change:

- role isolation and unauthorized access;
- request/response schema and safe error envelopes;
- optimistic concurrency and full-replacement semantics;
- tax precedence, missing/ambiguous rates, incompatible components, and rounding;
- invoice state transitions, numbering concurrency, and snapshot immutability;
- receipt method validation, idempotency, concurrency, overpayment prevention, confirmation, and reversal;
- settlement creation/reversal and balance calculation;
- user access changes, last-admin protection, password hashing, and session revocation;
- audit/outbox atomicity where applicable;
- historical import validation, preservation, reconciliation, and retry behavior;
- no dependency from the Core module into non-Core product modules.

Tests must use a disposable database and must never mutate production.

## 18. Product invariants

These statements are non-negotiable unless this specification is deliberately revised:

1. The server is authoritative for all financial calculations.
2. Money is never calculated with binary floating point.
3. An issued invoice is immutable and reproducible from its snapshot and line taxes.
4. Document numbers are unique within company, financial year, and kind; cancelled numbers are not reused.
5. No settlement may reduce an invoice below zero outstanding.
6. Cash receipts and commercial discounts remain distinct records and reporting amounts.
7. Historical invoices preserve historical printed values and never use current issuance behavior.
8. Core roles grant only Core capabilities.
9. All Core mutations require authenticated, authorized actors and are auditable.
10. Clients cannot directly access Core persistence or provide calculated totals as authority.
11. Master records are lifecycle-managed, versioned, and never hard-deleted through v1.
12. Shared catalog ownership is not duplicated in Core profiles.
13. Unsupported accounting, tax, compliance, delivery, and tenancy behavior must not be simulated by clients.

## 19. Change-control checklist

Every Core product change must answer and document:

- Which user and outcome does it serve?
- Is it Core-owned or an external-port responsibility?
- What role can read and mutate it?
- What are its validation, lifecycle, concurrency, idempotency, and deletion semantics?
- Does it affect money, tax, numbering, balances, snapshots, or historical reproducibility?
- What audit action and versioned domain event, if any, are required?
- Does it expose personal, banking, credential, or financial data?
- What migration/backfill and rollback strategy is required?
- What OpenAPI and client compatibility impact does it have?
- Which unit, integration, concurrency, authorization, and migration tests prove it?
- Has this document been updated in the same change?
