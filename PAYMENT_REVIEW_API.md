# Gateway payment review and resolution API

See [Admin UX API additions](ADMIN_UX_API.md) for directory search, relationship filters, enriched booking pagination and the authoritative payment-review shortcut/count.

All paths below are under `/api/v1/core`. Use existing Core staff session cookies.
This workflow makes explicit accounting decisions about verified provider payments;
retrying reconciliation remains a separate provider-observation operation.

## Routes and authorization

| Route                                                             | Identifier                                                                     | Roles                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `GET /payment-orders/:orderId/review`                             | Internal order UUID                                                            | CORE_ADMIN, CORE_REPORT_VIEWER, CORE_DATA_ENTRY |
| `POST /payment-attempts/:attemptId/resolve`                       | Internal attempt UUID                                                          | CORE_ADMIN only                                 |
| `POST /payment-orders/:orderId/reconcile-by-id`                   | Internal order UUID                                                            | CORE_ADMIN, CORE_DATA_ENTRY                     |
| Existing `POST /payment-orders/:orderId/reconcile`                | Provider order reference `er_` followed by 32 lowercase hexadecimal characters | CORE_ADMIN, CORE_DATA_ENTRY                     |
| Existing `POST /public/bookings/:token/orders/:orderId/reconcile` | Provider order reference and private booking token                             | Existing public compatibility                   |

The UUID and provider-reference contracts are separate, not ambiguously overloaded.
The frontend should use the new `reconcile-by-id` route with the report row's
`paymentOrderId`. It must not send that UUID to the legacy `/reconcile` route.
Staff inspection/resolution routes reject customer/feedback roles and signed-out
requests. No public or customer resolution route exists. Existing Core permissions
are global; there is no company-scoped tenancy in this repository.

## Inspection

The response is `{ data: PaymentReviewCase }` (complete TypeScript contracts below).
It includes order/provider status, booking/customer/invoice references, current
invoice balance, attempts and receipt links, immutable resolution history, and
per-attempt actions `{ action, allowed, blockers }`.

`reviewReasons` are persisted historical reasons, not guesses from current data.
Migration `0026_aberrant_gladiator.sql` assigns `UNKNOWN_LEGACY_REASON` to historical
review attempts without stored reasons. The read fallback also handles empty legacy
reason arrays. Resolving a case retains these reasons. Current eligibility is
reported independently in action blockers; the frontend must not derive it.

The version is an opaque SHA-256 concurrency token over relevant order, attempt,
booking, invoice balance, receipt, candidate-link and resolution facts. Routine
reconciliation timestamps do not invalidate it. Another financial change does.
Inspection does not call the provider, create a receipt or resolve a review.

## Resolution requests

Header: `Idempotency-Key` containing 8–128 letters, digits, underscores, colons or
hyphens. Every request requires the inspection's `version` and a nonblank `note`
(maximum 2,000 characters). One attempt can have one terminal decision.

Application:

```json
{
  "action": "APPLY_TO_LINKED_INVOICE",
  "version": "<inspection version>",
  "note": "Verified funds and current invoice eligibility"
}
```

Linking:

```json
{
  "action": "LINK_EXISTING_RECEIPT",
  "version": "<inspection version>",
  "note": "Verified the existing backend receipt represents this payment",
  "receiptId": "<selected matching receipt UUID>"
}
```

Completed external refund recording:

```json
{
  "action": "RECORD_VERIFIED_EXTERNAL_REFUND",
  "version": "<inspection version>",
  "note": "Checked the completed refund against retained settlement evidence",
  "refund": {
    "providerRefundReference": "refund-reference-from-provider",
    "amount": "30.00",
    "currency": "INR",
    "completedAt": "2026-10-07T10:00:00+05:30",
    "verification": {
      "kind": "STAFF_ATTESTATION",
      "evidenceReference": "Retained bank/provider refund statement identifier",
      "attested": true
    }
  }
}
```

Supply only fields belonging to the selected action. Refund references cannot
begin/end with whitespace and are at most 200 characters. Documentary evidence
references are nonblank, at most 1,000 characters. Completion timestamps must be
valid ISO date-times, no earlier than the payment completion (or initiation when
completion is unavailable), and no later than the current time.

Successful response: `{ data: { resolution: PaymentResolution, review: PaymentReviewCase } }`.
An identical retry with the same key, actor, attempt and original request returns
the same immutable resolution and a fresh case view, even though the original
version is now stale. Preserve the original body and key for network retries.
Changing any request field or actor with that key is a conflict.

### APPLY_TO_LINKED_INVOICE

Requires a positive, provider-verified `SUCCESS` in INR, currently requiring review,
an eligible INVOICED/CONFIRMED booking and currently linked issued invoice with
matching company/customer/service-category identity. The invoice must have enough
current outstanding balance. A harmless amount mismatch can be explicitly resolved
using the actual received amount, not the original order face amount.

The operation locks and rechecks eligibility, creates a confirmed GATEWAY receipt
using the actual India-time payment date, and links the order and attempt atomically.
Payments before the invoice date are allowed. Receipt numbering uses the actual
payment financial year. There must be no existing applied/canonical receipt on the
order and no other unrefunded successful attempt. Known additional successes are
not applied just to clear a flag. Existing matching receipts must use LINK instead.

### LINK_EXISTING_RECEIPT

The user must select a receipt returned in `matchingReceipts`; do not ask them to
invent evidence from reference text. Matching requires all of:

- Same currently linked invoice and company, exact amount, confirmed status.
- Persisted GATEWAY method.
- Exact provider/payment reference recorded by the backend.
- The deterministic backend gateway receipt idempotency identity for that same
  provider/payment ID (the `gw_` SHA-256 identity used by reconciliation).
- No attribution through an order or attempt FK to a different payment.
- The same single-applied-receipt-per-order and invoice/booking eligibility rules
  used by application, without applying the balance test a second time to already
  recorded receipt funds.

These identity checks are backend-only; the frontend receives candidate receipts
with `evidenceKind: BACKEND_GATEWAY_RECEIPT_IDENTITY`. Amount/reference text alone
or a manually recorded receipt is insufficient. Current confirmed balances remain
unchanged by linking; the report changes from an unlinked receipt plus reviewed
order to one authoritative gateway row. Prior receipt dates are preserved.

### RECORD_VERIFIED_EXTERNAL_REFUND

This records a completed external refund; it does not initiate or execute one.
The current provider adapter has no refund-verification method. This release
therefore supports **explicit administrator staff attestation only**, never a claim
that the provider verified the refund. `refundVerificationPolicy` is
`STAFF_ATTESTATION_ONLY`. The ledger retains the refund reference, exact amount,
currency, completion time, documentary evidence reference, attestation, staff note,
actor and recording timestamp. Staff must retain the referenced evidence externally.
There is no document-upload or independent provider-verification integration.

Only a complete refund of the reviewed attempt's exact amount and currency is
accepted. Zero, partial or wrong-currency refunds cannot clear the review. Refund
references are unique per provider across decisions. Recording is blocked while an
identified receipt is confirmed or pending; those funds cannot be removed from
review while still counted as collectible/confirmed receipt money. An already
reversed receipt is not proof of refund, but a separate evidenced full refund may
resolve an otherwise unresolved historical reversed-receipt case.

Foreign-currency attempts can be fully refunded in their own currency but cannot
be applied to an INR invoice. Their refund facts remain visible; INR summary
amounts exclude them.

## Accounting, reconciliation and checkout

Provider attempt `status` remains SUCCESS after any resolution. Accounting state
moves to APPLIED for application/linking or REFUNDED for full external refund.
Refund verification facts remain a separate dimension from payment success.

The order remains PAID when it has its canonical receipt; extra reviewed attempts
remain individually unresolved until explicitly resolved. An order without an
applied receipt becomes REFUNDED when all reviewed funds have been refunded, or
remains REVIEW_REQUIRED while any other reviewed funds remain. REFUNDED is a local
recorded refund disposition; `providerStatus` can still be PAID. Pending/unknown
attempts continue to block further checkout independently.

Reconciliation only automatically applies successful UNAPPLIED attempts. Its upsert
cannot overwrite accounting decisions or verified-success monetary facts; resolved
attempts are never reapplied. Polling a fully refunded order preserves its disposition.
A new late success on that order is reviewed as an additional success. Webhooks
continue to enqueue reconciliation; they cannot erase decisions or history.

The canonical receipt invariant remains one applied receipt per order. No automatic
invoice reassignment, partial refunds, unallocated credits, duplicate-payment
application, receipt reversal or refund initiation has been introduced.

A reversed APPLIED receipt without a recorded refund is exposed as
`REVERSED_WITHOUT_REFUND`, included in unresolved verified INR funds, and blocks
checkout. Existing manual endpoints prohibit reversing GATEWAY receipts. If a
receipt is reversed outside the supported workflow after an already terminal staff
resolution, the case remains visible and blocked; this release does not allow a
second terminal decision to overwrite history. It requires a separate accounting
amendment workflow.

Notes or acknowledgements alone never change review accounting. Checkout becomes
available only when no unresolved reviewed/reversed verified funds or pending
attempts remain, and existing booking/invoice/milestone eligibility is satisfied.

## Reason codes and current blockers

Persisted reason codes:

| Code                         | Meaning                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| AMOUNT_MISMATCH              | Verified amount differs from original order amount; safe expected/actual amounts retained |
| CURRENCY_MISMATCH            | Verified currency is not INR; expected/actual currencies retained                         |
| ADDITIONAL_SUCCESS           | Another success arrived on a paid/refunded order or an order with a receipt               |
| ORDER_ALREADY_UNDER_REVIEW   | Another success arrived while the order was already under review                          |
| BOOKING_MISSING              | No associated booking was found                                                           |
| BOOKING_INELIGIBLE           | Booking cannot currently collect payment                                                  |
| INVOICE_MISSING              | No invoice is linked                                                                      |
| INVOICE_NOT_ISSUED           | Invoice rejects settlement because it is not issued                                       |
| OVERPAYMENT                  | Current invoice balance is insufficient                                                   |
| RECEIPT_VALIDATION_FAILED    | Receipt creation failed a billing validation; safe error code retained                    |
| RECEIPT_IDEMPOTENCY_CONFLICT | Existing deterministic receipt identity conflicts with the creation request               |
| RECEIPT_NOT_CONFIRMED        | Existing gateway receipt is not confirmed                                                 |
| UNKNOWN_LEGACY_REASON        | Original reason was never persisted                                                       |

Current action blocker codes (separate from stored reasons):
`ALREADY_RESOLVED`, `PAYMENT_NOT_VERIFIED`, `ZERO_AMOUNT`, `ATTEMPT_NOT_REVIEWABLE`,
`CURRENCY_NOT_INR`, `INVOICE_MISSING`, `BOOKING_INELIGIBLE`, `INVOICE_NOT_ISSUED`,
`INVOICE_IDENTITY_MISMATCH`, `ORDER_ALREADY_HAS_RECEIPT`, `ADDITIONAL_SUCCESS`,
`OTHER_UNRESOLVED_SUCCESS`, `OVERPAYMENT`, `EXISTING_MATCHING_RECEIPT_USE_LINK`,
`EXISTING_RECEIPT_CONFLICT`, `NO_MATCHING_AUTHORITATIVE_RECEIPT`, `RECEIPT_NOT_REVERSED`.

## Error codes

Existing error envelope and request IDs are unchanged.

| Code / HTTP                                                 | Frontend behavior                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| REQUEST_VALIDATION_FAILED / 400                             | Correct UUIDs, enums, key, token or required fields                                                 |
| CORE_VALIDATION_FAILED / 422                                | Correct note, conditional action fields, evidence or refund completion time                         |
| CORE_NOT_FOUND / 404                                        | Order/attempt no longer exists or identifier is wrong                                               |
| Existing authentication failure / 401                       | Use normal sign-in/session handling                                                                 |
| CORE_ACCESS_REQUIRED / 403                                  | Inspection/resolution is not allowed for this role                                                  |
| PAYMENT_REVIEW_STALE / 409                                  | Refetch review and require another explicit confirmation; do not silently retry with a new token    |
| PAYMENT_ALREADY_RESOLVED / 409                              | Refetch and display the existing immutable decision                                                 |
| PAYMENT_RESOLUTION_IDEMPOTENCY_CONFLICT / 409               | A key was reused with different request/actor facts; do not retry a changed decision under that key |
| PAYMENT_RESOLUTION_NOT_ALLOWED / 409                        | Refetch and show action blockers; no client override                                                |
| PAYMENT_RECEIPT_EVIDENCE_INVALID / 409                      | Select an eligible receipt from matchingReceipts                                                    |
| PAYMENT_RECEIPT_NOT_CONFIRMED / 409                         | Existing receipt cannot support this decision                                                       |
| PAYMENT_REFUND_MUST_BE_COMPLETE / 409                       | Enter the exact full amount and payment currency                                                    |
| PAYMENT_REFUND_REFERENCE_USED / 409                         | Refund reference is already attributed to another decision                                          |
| OVERPAYMENT, INVOICE_NOT_ISSUED, IDEMPOTENCY_CONFLICT / 409 | Billing invariants still apply; refresh and investigate                                             |
| CORE_DATABASE_ERROR / 503                                   | Preserve the original body/key for a retry; no partial accounting changes commit                    |

## Unified report and CSV changes

Existing stable row IDs, one gateway row per order, filters and date basis remain.
New `gatewayStatus=REFUNDED` is accepted. `providerStatus` is exposed separately.
Attempt objects now include `id`, `reviewReasons`, `receiptStatus`, and
`receiptAccountingState`, in addition to existing safe payment/accounting facts.
Rows include `resolutions` with safe terminal action, actor/note, amount/currency,
receipt/refund references, verification trail and recording timestamp.

`providerConfirmedReviewAmount` is the sum of genuinely unresolved verified INR
attempts: REVIEW_REQUIRED, or APPLIED with a reversed receipt and no recorded refund.
`recordedExternalRefundAmount` is the sum of successful INR attempts recorded as
fully externally refunded. This field does not assert provider verification of the
refund. Both fields are present per row and in the complete-filter summary.

Receipt totals still use confirmed receipts once; refunded attempts cannot retain
confirmed receipts through this workflow. Gateway, receipt, unresolved review and
recorded refund amounts are separate overlapping dimensions; do not add them into
one cash total. Foreign-currency facts remain in attempts/resolutions, excluded
from INR summaries. CSV uses the same fields/filtering/deduplication, with nested
attempts and resolutions encoded as JSON. It now adds providerStatus, resolutions
and recordedExternalRefundAmount columns.

## Transaction and audit guarantees

Each resolution locks the order, booking, invoice and attempts, rechecks the current
balance/receipt attribution, and commits the receipt/link, accounting state, terminal
ledger entry and Core audit event atomically. Idempotency and provider/refund-reference
advisory locks plus unique indexes serialize retries and reference reuse. Competing
invoice receipts share the existing invoice lock. Failure at receipt creation or
audit persistence rolls the entire transaction back.

The decision ledger contains actor/action/note/references, before/after accounting
facts and timestamp. Database triggers reject updates and deletes; application
endpoints offer no history editing. Reason codes and prior resolutions survive
reconciliation. API/report responses exclude keys, request hashes, checkout secrets,
access tokens and raw provider payloads.

## TypeScript-ready HTTP contracts

The following contracts describe serialized HTTP data, not internal Date objects.

```ts
export const reviewReasonCodes = [
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'ADDITIONAL_SUCCESS',
  'ORDER_ALREADY_UNDER_REVIEW',
  'BOOKING_MISSING',
  'BOOKING_INELIGIBLE',
  'INVOICE_MISSING',
  'INVOICE_NOT_ISSUED',
  'OVERPAYMENT',
  'RECEIPT_VALIDATION_FAILED',
  'RECEIPT_IDEMPOTENCY_CONFLICT',
  'RECEIPT_NOT_CONFIRMED',
  'UNKNOWN_LEGACY_REASON',
] as const;
export type ReviewReasonCode = (typeof reviewReasonCodes)[number];
export interface ReviewReason {
  code: ReviewReasonCode;
  details: Record<string, string>;
}
export type ResolutionAction =
  'APPLY_TO_LINKED_INVOICE' | 'LINK_EXISTING_RECEIPT' | 'RECORD_VERIFIED_EXTERNAL_REFUND';
export type ResolutionInput = {
  version: string;
  note: string;
} & (
  | { action: 'APPLY_TO_LINKED_INVOICE' }
  | { action: 'LINK_EXISTING_RECEIPT'; receiptId: string }
  | {
      action: 'RECORD_VERIFIED_EXTERNAL_REFUND';
      refund: {
        providerRefundReference: string;
        amount: string;
        currency: string;
        completedAt: string;
        verification: { kind: 'STAFF_ATTESTATION'; evidenceReference: string; attested: true };
      };
    }
);
/** HTTP contracts: timestamps are serialized ISO strings, dates remain YYYY-MM-DD. */
export type AccountingStatus = 'UNAPPLIED' | 'APPLIED' | 'REVIEW_REQUIRED' | 'REFUNDED';
export type GatewayOrderStatus =
  'CREATING' | 'READY' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'REVIEW_REQUIRED' | 'REFUNDED';
export type ReceiptStatus = 'PENDING' | 'CONFIRMED' | 'REVERSED';
export interface ReviewReceipt {
  id: string;
  invoiceId: string;
  number: string;
  status: ReceiptStatus;
  amount: string;
  receivedDate: string;
  method: 'CASH' | 'CHEQUE' | 'DD' | 'CARD' | 'UPI' | 'GATEWAY';
  reversalReason: string | null;
}
export interface PaymentResolution {
  id: string;
  attemptId: string;
  orderId: string;
  action: ResolutionAction;
  actorId: string;
  note: string;
  receiptId: string | null;
  amount: string;
  currency: string;
  provider: string;
  providerRefundReference: string | null;
  refund: Extract<ResolutionInput, { action: 'RECORD_VERIFIED_EXTERNAL_REFUND' }>['refund'] | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
}
export interface PaymentReviewCase {
  version: string;
  order: {
    id: string;
    provider: string;
    providerOrderId: string;
    providerStatus: string | null;
    gatewayStatus: GatewayOrderStatus;
    amount: string;
    receiptId: string | null;
    paidAt: string | null;
  };
  booking: { id: string; reference: string; status: string; companyId: string } | null;
  customer: { id: string; name: string } | null;
  invoice: {
    id: string;
    number: string | null;
    status: 'DRAFT' | 'ISSUED' | 'CANCELLED';
    invoiceDate: string;
    grandTotal: string;
    receivedAmount: string;
    adjustmentAmount: string;
    dueAmount: string;
    paymentStatus: 'NOT_APPLICABLE' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  } | null;
  attempts: {
    id: string;
    providerPaymentId: string;
    status:
      | 'NOT_ATTEMPTED'
      | 'PENDING'
      | 'SUCCESS'
      | 'FAILED'
      | 'USER_DROPPED'
      | 'CANCELLED'
      | 'VOID'
      | 'UNKNOWN';
    accountingStatus: AccountingStatus;
    amount: string;
    currency: string;
    initiatedAt: string;
    completedAt: string | null;
    reviewReasons: ReviewReason[];
    receipt: ReviewReceipt | null;
    receiptAccountingState: ReceiptStatus | 'REVERSED_WITHOUT_REFUND' | null;
    resolution: PaymentResolution | null;
    actions: { action: ResolutionAction; allowed: boolean; blockers: string[] }[];
    matchingReceipts: (ReviewReceipt & { evidenceKind: 'BACKEND_GATEWAY_RECEIPT_IDENTITY' })[];
    existingPaymentReceipts: ReviewReceipt[];
  }[];
  history: PaymentResolution[];
  refundVerificationPolicy: 'STAFF_ATTESTATION_ONLY';
}
export interface PaymentReviewEnvelope {
  data: PaymentReviewCase;
}
export interface PaymentResolutionEnvelope {
  data: { resolution: PaymentResolution; review: PaymentReviewCase };
}
```

## Exact example responses

[payment-review-examples.json](payment-review-examples.json) contains three complete,
serialized responses generated from isolated integration-test fixtures:

- `applicablePayment`: an issued invoice and verified INR review attempt with
  APPLY_TO_LINKED_INVOICE allowed (including actual-amount resolution).
- `additionalSuccessfulPayment`: a paid canonical receipt plus a separate additional
  success; application/linking are blocked, full evidenced external refund recording
  remains available for the duplicate funds.
- `ineligibleInvoice`: a cancelled invoice; invoice accounting actions are unavailable,
  with INVOICE_NOT_ISSUED listed explicitly.

Each value is the exact `{ data: PaymentReviewCase }` envelope. Example UUIDs,
references, notes and versions belong to disposable test fixtures and must not be
submitted to a running real API. Refetch the real case to obtain its version.

## Verification

Verified on a fresh isolated PostgreSQL database: 79 billing/payment/review/report
integration tests passed. The ordinary unit suite passed 163 tests; its database
suites are skipped without TEST_DATABASE_URL and were exercised separately for
this financial workflow. Type, lint and build checks are part of delivery.
