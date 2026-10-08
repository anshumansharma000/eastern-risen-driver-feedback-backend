# Admin UX list and payment-review additions

All requests use the existing staff session cookie and `/api/v1/core` prefix.
Existing invoice search stays at `GET /reports/invoices`; no duplicate invoice endpoint
is introduced. The additions below require no new database migration, backfill or
index. Deploy on the repository's existing schema through migration 0026.

## Master directories and staff

`GET /guests`, `/hotels`, `/hotel-rates`, `/vendors`, `/vendor-profiles`, `/vehicles`,
`/companies`, `/bank-accounts`, `/service-categories`, `/tax-rules` and `/users`
accept optional `q` (up to 200 characters). Search trims surrounding whitespace,
ignores case, matches literal substrings and treats blank search as omitted.
`%`, `_` and backslashes are literal characters, not search wildcards.
Search and all filters apply before pagination and the count.

| Resource           | Search fields                                                                | Optional relationship |
| ------------------ | ---------------------------------------------------------------------------- | --------------------- |
| guests             | name, phone, mobileNumber, email, contactPerson                              | —                     |
| hotels             | name, city, phone, mobileNumber, email, contactPerson                        | —                     |
| hotel-rates        | name, plan                                                                   | hotelId               |
| vendors            | name, contactName, contactEmail, contactPhone                                | —                     |
| vendor-profiles    | address, city, state, country, postalCode, mobileNumber                      | vendorId              |
| vehicles           | registrationNumber, displayName, registeredOwner, contactNumber, vehicleType | —                     |
| companies          | name, phone, mobileNumber, email                                             | —                     |
| bank-accounts      | name, bankName, branch, ifscCode, swiftCode                                  | companyId             |
| service-categories | name, code                                                                   | —                     |
| tax-rules          | name, component                                                              | —                     |
| users              | displayName, username, email                                                 | —                     |

Relationship values must be UUIDs. Valid unmatched IDs produce an empty page;
malformed IDs return HTTP 400. Relationship, search and status filters combine
with AND. Search fields within a resource combine with OR. Vendor profiles have
no name/code field; search vendor names through `/vendors` and use `vendorId`
for the contextual profile list.

Defaults: `page=1`, `pageSize=25`, maximum page size 100. Core masters include all
statuses when status is omitted; their statuses remain `ACTIVE|INACTIVE|ARCHIVED`.
Vendors and vehicles preserve the default exclusion of archived records and
support `ACTIVE|DEACTIVATED|ARCHIVED`. Users include all Core staff statuses when
omitted and support `ACTIVE|DEACTIVATED|ARCHIVED`. Non-Core identities never appear
in the users list. Staff listing remains Core Admin only; master/catalog reads
retain the existing Core Admin, Core Report Viewer and Core Data Entry permissions.

Sorting remains ascending name then ID for named Core masters and vendors,
ascending registration then ID for vehicles, display name then ID for users, and
ID for vendor profiles. Responses preserve existing row fields and add no secrets.

Exact example request:

```http
GET /api/v1/core/bank-accounts?companyId=11111111-1111-4111-8111-111111111111&q=%20OPERATING%20&status=ACTIVE&page=1&pageSize=25
```

Example response for a matching bank account:

```json
{
  "data": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "companyId": "11111111-1111-4111-8111-111111111111",
      "name": "Operating Account",
      "accountNumber": "TEST-ACCOUNT",
      "bankName": "Example Bank",
      "branch": "Bhubaneswar",
      "ifscCode": "TEST0000001",
      "swiftCode": null,
      "status": "ACTIVE",
      "version": 1,
      "createdAt": "2026-10-08T00:00:00.000Z",
      "updatedAt": "2026-10-08T00:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "pageSize": 25, "total": 1 }
}
```

The other contextual requests follow the same envelope:

```http
GET /api/v1/core/hotel-rates?hotelId=33333333-3333-4333-8333-333333333333&q=APAI&status=ACTIVE
GET /api/v1/core/vendor-profiles?vendorId=44444444-4444-4444-8444-444444444444&q=Bhubaneswar&status=ACTIVE
GET /api/v1/core/vehicles?q=Owner&status=ACTIVE&page=2&pageSize=25
GET /api/v1/core/users?q=manager&status=ACTIVE
```

Invoice writes already reject missing, inactive, duplicate or other-company bank
accounts server-side. That validation and the financial write paths are unchanged.

## Commercial booking register

`GET /commercial-bookings` accepts:

| Query                              | Values / behavior                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| q                                  | Trimmed case-insensitive literal substring of reference, title or current customer name; max 200 characters |
| status                             | DRAFT, QUOTED, INVOICED, CONFIRMED, CANCELLED, COMPLETED                                                    |
| companyId, customerId              | UUID; AND with other filters                                                                                |
| serviceStartsFrom, serviceStartsTo | Inclusive YYYY-MM-DD calendar dates on serviceStartsOn; either bound can be omitted                         |
| quoteAcceptance                    | NONE, AWAITING_ACCEPTANCE, ACCEPTED                                                                         |
| page, pageSize                     | Defaults 1 and 25; maximum pageSize 100                                                                     |

Omitted filters select the whole register. Date-filtered results exclude null
serviceStartsOn. Invalid dates, UUIDs or enums return HTTP 400. A valid calendar
range with the end before the start returns HTTP 422 `CORE_VALIDATION_FAILED`.
Sorting is createdAt descending then booking ID descending. Pagination totals are
accurate even for an empty/out-of-range page. The booking count and page use one
database snapshot; enrichment uses one SQL query rather than separate calls per row.

Acceptance refers to the highest quote version, including legacy quotes without
structured pricing: NONE means no quote exists; AWAITING_ACCEPTANCE means a latest
quote exists with null acceptedAt; ACCEPTED means its acceptedAt is non-null. An
accepted older quote does not make an unaccepted newer quote accepted. Expiry does
not alter these acceptance categories or the quote-acceptance write behavior.

`data` remains an array. Each row adds customerName, latestQuoteVersion,
latestQuoteAcceptedAt, invoiceNumber, receivedAmount and dueAmount. Absent quotes
produce null quote fields. Absent invoices produce null invoiceNumber,
receivedAmount and dueAmount. Financial amounts are exact decimal strings using
the existing invoice report's CURRENT balance basis: confirmed receipts, excluding
pending/reversed receipts; due subtracts active settlement adjustments. As in the
invoice report, dueAmount is `"0.00"` for an existing non-issued invoice. Gateway
attempt/order amounts are never added to receipt balances. The private
accessTokenHash is excluded from list responses.

Exact request:

```http
GET /api/v1/core/commercial-bookings?q=Coastal&companyId=11111111-1111-4111-8111-111111111111&customerId=55555555-5555-4555-8555-555555555555&status=QUOTED&serviceStartsFrom=2026-10-01&serviceStartsTo=2026-10-31&quoteAcceptance=AWAITING_ACCEPTANCE&page=1&pageSize=25
```

Example response with a latest unaccepted legacy quote and no linked invoice:

```json
{
  "data": [
    {
      "id": "66666666-6666-4666-8666-666666666666",
      "reference": "BOOK-COASTAL-001",
      "companyId": "11111111-1111-4111-8111-111111111111",
      "customerId": "55555555-5555-4555-8555-555555555555",
      "serviceCategoryId": "77777777-7777-4777-8777-777777777777",
      "title": "Coastal tour",
      "serviceStartsOn": "2026-10-20",
      "serviceEndsOn": "2026-10-24",
      "status": "QUOTED",
      "invoiceId": null,
      "paymentActivation": null,
      "createdBy": "88888888-8888-4888-8888-888888888888",
      "createdAt": "2026-10-08T00:00:00.000Z",
      "updatedAt": "2026-10-08T00:00:00.000Z",
      "customerName": "Example Customer",
      "latestQuoteVersion": 2,
      "latestQuoteAcceptedAt": null,
      "invoiceNumber": null,
      "receivedAmount": null,
      "dueAmount": null
    }
  ],
  "pagination": { "page": 1, "pageSize": 25, "total": 1 }
}
```

For a linked issued invoice totaling `"1000.00"` with confirmed receipts totaling
`"120.30"` and active adjustments totaling `"10.00"`, the financial fields are
`"receivedAmount": "120.30"` and `"dueAmount": "869.70"`, matching `/reports/invoices`.

## Payment review shortcut and Overview

`GET /reports/payments?needsReview=true` selects gateway payment orders requiring
attention using the same predicate exposed as `data.needsReview` on
`GET /payment-orders/:orderId/review`. Report rows also include boolean needsReview
(manual receipt rows are false). `needsReview=false` or omission leaves the existing
report unfiltered; false does **not** mean “only resolved orders.” Invalid boolean
values return HTTP 400. Existing filters, pagination, summaries, sorting and roles
remain supported. `gatewayStatus=REVIEW_REQUIRED` retains its narrower old meaning.

An order requires review if any of these is true:

- Its status is REVIEW_REQUIRED.
- Its reviewRequiredAt marker is non-null, including marked unresolved pending or
  unknown provider observations.
- An attempt has accountingStatus REVIEW_REQUIRED.
- An attempt has accountingStatus APPLIED and its linked receipt is REVERSED.
  For legacy attribution, use the order receipt when the attempt has no receipt
  and its providerPaymentId matches the order's providerPaymentId.

These rules include otherwise PAID orders, do not use historical reason arrays or
refund amounts, and remain independent of whether a resolution action is currently
allowed. The existing inspection action blockers still control resolution.
The report has one row per order, even with multiple unresolved attempts.

Exact review/export requests:

```http
GET /api/v1/core/reports/payments?needsReview=true&page=1&pageSize=25
GET /api/v1/core/reports/payments/export?needsReview=true
GET /api/v1/core/reports/payments?needsReview=true&companyId=11111111-1111-4111-8111-111111111111&gatewayStatus=PAID
```

Export applies the same review predicate, other filters and ordering, exports the
whole filtered result regardless of page/pageSize, and retains the 100,000-row cap.

Exact request with a necessarily empty result (manual rows cannot require gateway
review):

```http
GET /api/v1/core/reports/payments?needsReview=true&source=MANUAL
```

Example complete response (generatedAt varies):

```json
{
  "data": [],
  "summary": {
    "total": 0,
    "manualCount": 0,
    "gatewayCount": 0,
    "confirmedReceiptCount": 0,
    "confirmedReceiptAmount": "0.00",
    "pendingReceiptCount": 0,
    "pendingReceiptAmount": "0.00",
    "reversedReceiptCount": 0,
    "reversedReceiptAmount": "0.00",
    "providerConfirmedReviewAmount": "0.00",
    "recordedExternalRefundAmount": "0.00",
    "gatewayStatusBreakdown": []
  },
  "pagination": { "page": 1, "pageSize": 25, "total": 0 },
  "meta": {
    "currency": "INR",
    "dateBasis": "PAYMENT_ACTIVITY_IST",
    "from": null,
    "to": null,
    "balanceBasis": "CURRENT",
    "generatedAt": "2026-10-08T00:00:00.000Z"
  }
}
```

`GET /reports/dashboard` adds integer `data.alerts.paymentsRequiringReview` to the
existing alerts object. For example, its added field can be
`"paymentsRequiringReview": 4` when four distinct orders meet the rules, even if
one order has several unresolved attempts. This is a **global operational count**:
dashboard from/to, companyId, customerCategory and serviceCategoryId do not affect
it, consistent with the existing configuration alerts. The Overview shortcut should
open `/reports/payments?needsReview=true` with no dashboard scope filters to match
the badge. A scoped payments report can intentionally show a smaller count.

## Frontend adoption and validation

Send q when the user searches and reset page to 1 when a filter changes. Use the
validated relationship parameters instead of fetching all pages for contextual
lists. Read booking pagination.total; keep rendering response.data as the array.
Render absent-invoice balances as unavailable, and use needsReview=true for the
Payments review shortcut. Continue using the existing invoice report for invoice
search, status/date/payment filters and the Drafts shortcut.

The new integration suite uses isolated fixtures with more than 100 directory and
booking rows, combined filters, blank/case/literal searches, invalid UUID/date/enum
values, latest legacy quotes, receipt/adjustment parity, paid orders with multiple
review attempts, legacy receipt reversals, export parity and role boundaries. It
also verifies existing invoice bank ownership validation. No invitation or real
payment is sent. No new index is added without representative query-plan evidence;
existing quote-version, receipt/invoice and ID indexes remain available.

Optional audit actor names and an authoritative audit action/entity catalogue are
not included in this change; existing audit IDs, payloads and permissions remain.
