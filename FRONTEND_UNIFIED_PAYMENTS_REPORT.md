# Unified staff payments report — frontend handoff

See [Admin UX API additions](ADMIN_UX_API.md) for directory search, relationship filters, enriched booking pagination and the authoritative payment-review shortcut/count.

## Endpoints and access

- `GET /api/v1/core/reports/payments` — JSON report.
- `GET /api/v1/core/reports/payments/export` — complete filtered CSV.

Use the existing Core session cookie. Allowed roles: `CORE_ADMIN`,
`CORE_REPORT_VIEWER`, `CORE_DATA_ENTRY`. Signed-out requests return 401; other
roles return 403. These are staff endpoints, never public booking or customer
account endpoints. Existing Core access is global: the repository has no
company-scoped tenancy. Do not inject a default company/customer filter in the UI.
Inactive companies/customers and cancelled invoices/bookings remain reportable.

Apply migration `0025_young_penance.sql` before rollout. It adds non-unique
receipt-link indexes to payment orders and attempts; no data backfill is needed.

## Query parameters

All parameters are optional. Unknown parameters and invalid enum/sort values are
rejected by the existing request validator. Calendar dates must be valid; `from`
after `to` is rejected.

| Parameter                                      | Values / semantics                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`                                   | Inclusive `YYYY-MM-DD` report-date boundaries. Omitted bounds are unbounded. Both omitted means all history.                                                                                                                                    |
| `source`                                       | `MANUAL`, `GATEWAY`                                                                                                                                                                                                                             |
| `receiptStatus`                                | `PENDING`, `CONFIRMED`, `REVERSED`                                                                                                                                                                                                              |
| `gatewayStatus`                                | `CREATING`, `READY`, `PAID`, `EXPIRED`, `TERMINATED`, `REVIEW_REQUIRED`, `REFUNDED`                                                                                                                                                             |
| `method`                                       | `CASH`, `CHEQUE`, `DD`, `CARD`, `UPI`, `GATEWAY`; matches the linked receipt's persisted method. An order without a receipt has `method: null`.                                                                                                 |
| `companyId`, `customerId`, `serviceCategoryId` | UUID; exact match                                                                                                                                                                                                                               |
| `customerCategory`                             | `AGENT`, `LEISURE`, `CORPORATE`; invoice snapshot category when available, otherwise current customer category                                                                                                                                  |
| `q`                                            | 1–200 characters; trimmed, case-insensitive literal substring of receipt number/reference, provider order/payment reference, attempt payment reference, invoice number, booking reference or customer name. `%` and `_` are literal characters. |
| `page`                                         | Integer 1–1,000,000; default 1                                                                                                                                                                                                                  |
| `pageSize`                                     | Integer 1–100; default 25                                                                                                                                                                                                                       |
| `sortBy`                                       | `activityAt` (default), `createdAt`, `receivedDate`, `paidAt`, `amount`, `source`, `method`, `receiptStatus`, `gatewayStatus`, `receiptNumber`, `providerOrderId`, `invoiceNumber`, `bookingReference`, `customer`                              |
| `sortOrder`                                    | `asc`, `desc` (default)                                                                                                                                                                                                                         |

Filters intersect with AND. A gateway-status filter excludes manual rows. A
receipt-status or method filter excludes orders without a receipt. For example,
`source=MANUAL&gatewayStatus=PAID` yields zero rows, as does
`gatewayStatus=REVIEW_REQUIRED&receiptStatus=CONFIRMED` when the review orders have
no receipts. Receipt status is independent of gateway status. `customer` sorts by
the exposed customer name; `amount` sorts numerically. Null values sort last.
Every sort has the stable unique row ID descending as its final tie-breaker.

## Date basis

`activityAt` is the first available value in this order:

1. Gateway order `paidAt`.
2. Receipt `receivedDate`, represented as midnight in `Asia/Kolkata`.
3. Gateway order or manual receipt `createdAt`.

`reportDate` is `activityAt`'s calendar date in `Asia/Kolkata` (UTC+05:30).
Both filtering and default sorting use this basis. An order without a receipt
or payment timestamp remains visible through its creation date. Gateway successes
awaiting review normally retain their verified payment timestamp in `paidAt`.
Reversals retain the original payment/receipt date; this is a payments register,
not a feed sorted by the reversal time.

Date-only values retain their calendar dates and must not be parsed as UTC and
shifted for display. Timestamps are ISO 8601 strings with an explicit offset;
render them in India time. A payment at `2026-10-06T18:30:00Z` belongs to 7 October.
A payment at `2026-10-07T18:29:59Z` also belongs to 7 October; one second later
belongs to 8 October. The database session's timezone does not affect the date
filter. Payments can precede the invoice date.

## Rows, identity and accounting

One row represents either an unlinked receipt (`manual:<receipt UUID>`) or a
payment order (`gateway:<order UUID>`). The gateway row includes the canonical
receipt linked by `payment_orders.receipt_id`. When that link is absent, the
latest persisted attempt with a receipt FK provides the receipt. Linked receipts
are excluded from the manual branch through these authoritative relationships.
The current reconciliation workflow applies at most one receipt per order;
additional successful attempts are retained for review without creating another
receipt. Payment method/reference text and creator never determine source.
An unlinked receipt with method `GATEWAY` is still `MANUAL` in this register:
`MANUAL` denotes the receipt branch without a persisted gateway relationship.

All states appear by default. There is no unified `status` parameter or field:
use `receiptStatus` and `gatewayStatus` separately. Persisted order statuses are
not the browser's derived payment-result statuses: **`PENDING` is an attempt
status, not an accepted `gatewayStatus` value**.

| Row field                                                                                                                | Type / definition                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `source`                                                                                                           | Stable prefixed identifier; `MANUAL` or `GATEWAY`                                                                                                                                    |
| `amount`                                                                                                                 | INR decimal string, two fractional digits. Order face amount for GATEWAY; receipt amount for MANUAL. This is not necessarily collected money.                                        |
| `createdAt`, `activityAt`                                                                                                | ISO timestamp strings                                                                                                                                                                |
| `reportDate`                                                                                                             | `YYYY-MM-DD`                                                                                                                                                                         |
| `receivedDate`                                                                                                           | Receipt calendar date or null                                                                                                                                                        |
| `paidAt`                                                                                                                 | Persisted gateway payment timestamp or null                                                                                                                                          |
| `method`                                                                                                                 | Persisted receipt method or null                                                                                                                                                     |
| `receiptId`, `receiptNumber`, `receiptStatus`, `reversalReason`                                                          | Linked receipt facts or null                                                                                                                                                         |
| `receiptAmount`                                                                                                          | Receipt amount as INR decimal string or null; used for receipt summaries, independently of order face amount                                                                         |
| `paymentOrderId`, `gatewayStatus`, `provider`, `providerOrderId`, `providerPaymentId`                                    | Persisted gateway facts or null for manual rows                                                                                                                                      |
| `invoiceId`, `invoiceNumber`, `bookingId`, `bookingReference`                                                            | Associated identifiers/references or null                                                                                                                                            |
| `companyId`, `companyName`, `customerId`, `customerName`, `customerCategory`, `serviceCategoryId`, `serviceCategoryName` | Associated identities or null; customer/category display facts use invoice snapshots when available                                                                                  |
| `details`                                                                                                                | Whitelisted receipt details: `reference`, `bankName`, `instrumentDate`, `cardLastFour`, only when present; otherwise `{}`                                                            |
| `attempts`                                                                                                               | Array of safe attempt facts; empty for manual receipts and unattempted orders                                                                                                        |
| `providerConfirmedReviewAmount`                                                                                          | Exact sum of this order's persisted INR `SUCCESS` attempts with accounting status `REVIEW_REQUIRED`; `0.00` for manual rows. Distinct from order face amount and confirmed receipts. |

Attempt objects contain `id`, `reviewReasons`, `receiptStatus`, `receiptAccountingState`, `providerPaymentId`, `status`, `accountingStatus`,
`amount` (decimal string), `currency`, `receiptId`, `initiatedAt`, `completedAt`.
They are sorted by initiation time and attempt UUID descending.
Attempt statuses: `NOT_ATTEMPTED`, `PENDING`, `SUCCESS`, `FAILED`, `USER_DROPPED`,
`CANCELLED`, `VOID`, `UNKNOWN`. Accounting statuses: `UNAPPLIED`, `APPLIED`,
`REVIEW_REQUIRED`, `REFUNDED`. Foreign-currency anomalies remain identifiable in attempts
but are excluded from the INR review amount.

`PAID` plus `receiptStatus: REVERSED` preserves both facts; a reversed receipt
is **not** proof of a gateway refund. A `PAID` order may also have additional
successful funds requiring review: inspect `providerConfirmedReviewAmount` and
attempt accounting status. Do not treat pending/failed attempts, ready orders,
or order face amounts as money received. No checkout session IDs, access tokens,
credentials, raw gateway payloads or receipt idempotency hashes are returned.

## Response and summary

The envelope is `{ data, summary, pagination, meta }`. Pagination describes the
filtered row count and requested page. Summary uses the **entire filtered result**,
including when the requested page is empty. The page and summary come from a
single database statement/snapshot. Monetary sums use PostgreSQL numeric
arithmetic and are returned as decimal strings; never convert to floating-point
for financial calculations.

- `total`: unified row count; equals pagination total.
- `manualCount`, `gatewayCount`: source counts; their sum equals total.
- `confirmedReceiptCount`, `confirmedReceiptAmount`: linked/unlinked confirmed
  receipts counted once. This is the receipt-accounting collection dimension.
- `pendingReceiptCount`, `pendingReceiptAmount`: pending receipt count and amount;
  not confirmed collection.
- `reversedReceiptCount`, `reversedReceiptAmount`: reversed receipt count and
  original receipt amount; not an inferred refund.
- `gatewayStatusBreakdown`: observed gateway statuses, ordered alphabetically;
  each object has `status`, `count`, `amount`. Amount is the sum of order face
  amounts in that persisted state. Absent states are omitted; no orders yields `[]`.
- `providerConfirmedReviewAmount`: exact filtered sum of verified INR successes
  still unresolved (review required or an applied receipt reversed without refund), including extra successes on paid orders.
- `recordedExternalRefundAmount`: filtered INR amount of recorded completed full external refunds, with verification facts exposed separately.

**Receipt summaries and gateway breakdowns are overlapping dimensions. Never add
these amounts together.** No aggregate `totalAmount` is provided because mixed
pending, reversed and order face amounts do not represent a coherent cash total.

`meta` includes `currency: INR`, `dateBasis: PAYMENT_ACTIVITY_IST`, nullable
`from`/`to`, `balanceBasis: CURRENT` (existing report convention; current persisted
states, not historical as-of balances), and ISO `generatedAt`.

Example: a single verified sandbox collection awaiting review, without a receipt:

```json
{
  "data": [
    {
      "id": "gateway:66f1e856-1af6-48a3-ac6f-0d6f3d6a2123",
      "source": "GATEWAY",
      "amount": "56700.00",
      "createdAt": "2026-10-07T10:41:41.243+00:00",
      "activityAt": "2026-10-07T10:46:30+00:00",
      "reportDate": "2026-10-07",
      "receivedDate": null,
      "paidAt": "2026-10-07T10:46:30+00:00",
      "method": null,
      "receiptId": null,
      "receiptNumber": null,
      "receiptStatus": null,
      "receiptAmount": null,
      "reversalReason": null,
      "paymentOrderId": "66f1e856-1af6-48a3-ac6f-0d6f3d6a2123",
      "gatewayStatus": "REVIEW_REQUIRED",
      "provider": "cashfree",
      "providerOrderId": "er_66f1e8561af648a3ac6f0d6f3d6a2123",
      "providerPaymentId": "1461310533244836352",
      "providerStatus": "PAID",
      "resolutions": [],
      "recordedExternalRefundAmount": "0.00",
      "providerConfirmedReviewAmount": "56700.00",
      "invoiceId": "4bd2931d-c841-4516-bf96-2178e782138e",
      "invoiceNumber": "I/2627/000012",
      "bookingId": "11111111-1111-4111-8111-111111111111",
      "bookingReference": "Test12",
      "companyId": "22222222-2222-4222-8222-222222222222",
      "companyName": "Eastern Risen",
      "customerId": "33333333-3333-4333-8333-333333333333",
      "customerName": "Example Customer",
      "customerCategory": "LEISURE",
      "serviceCategoryId": "44444444-4444-4444-8444-444444444444",
      "serviceCategoryName": "Tour",
      "details": {},
      "attempts": [
        {
          "id": "55555555-5555-4555-8555-555555555555",
          "reviewReasons": [{ "code": "UNKNOWN_LEGACY_REASON", "details": {} }],
          "receiptStatus": null,
          "receiptAccountingState": null,
          "providerPaymentId": "1461310533244836352",
          "status": "SUCCESS",
          "accountingStatus": "REVIEW_REQUIRED",
          "amount": "56700.00",
          "currency": "INR",
          "receiptId": null,
          "initiatedAt": "2026-10-07T10:46:21+00:00",
          "completedAt": "2026-10-07T10:46:30+00:00"
        }
      ]
    }
  ],
  "summary": {
    "total": 1,
    "manualCount": 0,
    "gatewayCount": 1,
    "confirmedReceiptCount": 0,
    "confirmedReceiptAmount": "0.00",
    "pendingReceiptCount": 0,
    "pendingReceiptAmount": "0.00",
    "reversedReceiptCount": 0,
    "reversedReceiptAmount": "0.00",
    "providerConfirmedReviewAmount": "56700.00",
    "recordedExternalRefundAmount": "0.00",
    "gatewayStatusBreakdown": [{ "status": "REVIEW_REQUIRED", "count": 1, "amount": "56700.00" }]
  },
  "pagination": { "page": 1, "pageSize": 25, "total": 1 },
  "meta": {
    "currency": "INR",
    "dateBasis": "PAYMENT_ACTIVITY_IST",
    "from": null,
    "to": null,
    "balanceBasis": "CURRENT",
    "generatedAt": "2026-10-07T11:00:00.000Z"
  }
}
```

This is an illustrative contract example; placeholder party/booking IDs and
labels are not a database dump. A manual cash row has `source: MANUAL`,
`method: CASH`, its receipt fields populated, and all gateway fields null.
An order with a receipt includes both sets of fields in the same gateway row.

Example requests:

```text
GET /api/v1/core/reports/payments
GET /api/v1/core/reports/payments?source=GATEWAY&gatewayStatus=REVIEW_REQUIRED
GET /api/v1/core/reports/payments?receiptStatus=REVERSED&from=2026-10-01&to=2026-10-31
GET /api/v1/core/reports/payments?customerCategory=AGENT&q=Test12&page=1&pageSize=25
GET /api/v1/core/reports/payments/export?companyId=22222222-2222-4222-8222-222222222222
```

## CSV

Same filters, sorting, date basis and deduplication as JSON. `page`/`pageSize` are
validated but ignored for export. Exports return all filtered rows in one
snapshot up to the existing 100,000-row limit; larger results return 413 with
`REPORT_EXPORT_TOO_LARGE`. No silent truncation. Content type is
`text/csv; charset=utf-8`, filename `payments.csv`, UTF-8 BOM, CRLF separators.
Cells are quoted, quotes are doubled, and leading `=`, `+`, `-`, `@` are prefixed
with an apostrophe using the existing CSV convention. Empty exports retain headers.
Nested details and attempts are JSON cells.

Exact column order:

```text
id,source,amount,activityAt,reportDate,createdAt,receivedDate,paidAt,method,
receiptId,receiptNumber,receiptStatus,receiptAmount,reversalReason,paymentOrderId,
gatewayStatus,provider,providerOrderId,providerPaymentId,providerStatus,providerConfirmedReviewAmount,
invoiceId,invoiceNumber,bookingId,bookingReference,companyId,companyName,customerId,
customerName,customerCategory,serviceCategoryId,serviceCategoryName,details,attempts,resolutions,recordedExternalRefundAmount
```

## Existing receipt report compatibility

`GET /api/v1/core/reports/payments-received` and its `/export` now include all
receipt statuses when `status` is omitted. To preserve the previous confirmed-only
view, send `status=CONFIRMED` explicitly. The existing receipt summary field names
(`confirmedCount`, `confirmedAmount`, `pendingCount`, `pendingAmount`,
`reversedCount`, `reversedAmount`) are unchanged. `method=GATEWAY` is now accepted.
Its existing date basis and default current financial-year range remain unchanged.
It remains a receipt-only report: use the new unified endpoints for gateway orders
without receipts. The unified endpoints use `receiptStatus`, not legacy `status`.

## Gateway review workflow extension

See [PAYMENT_REVIEW_API.md](PAYMENT_REVIEW_API.md) and
[the frontend review implementation prompt](FRONTEND_GATEWAY_PAYMENT_REVIEW_PROMPT.md)
for internal UUID inspection/resolution and corrected reconciliation routing.
Migration `0026_aberrant_gladiator.sql` adds persistent reasons and immutable decisions.

The report now additionally accepts `gatewayStatus=REFUNDED`, exposes separate
`providerStatus`, safe attempt IDs/review reasons/receipt status/accounting state,
`resolutions`, and row/full-filter `recordedExternalRefundAmount`. REFUNDED records
an external-refund accounting disposition, not a changed provider payment status.
Provider status can remain PAID and attempt status remains SUCCESS. Refund evidence
is labelled STAFF_ATTESTATION; no provider refund-verification API is implemented.

Verified APPLIED funds whose receipts are reversed without a recorded refund are
included in providerConfirmedReviewAmount and block customer checkout. Completed
refunds reduce unresolved review amounts but are separate from confirmed receipt
money. A remaining additional success stays unresolved even when another attempt
has already paid the order. CSV adds providerStatus, resolutions and
recordedExternalRefundAmount; safe attempt details include the new review fields.
