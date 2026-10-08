Implement the staff gateway-payment review workflow in the Eastern Risen admin frontend. Complete the code and verification, not just a design proposal.

Read your repository's AGENTS.md and reuse its authenticated Core API client, role permissions, report table, dialogs, money formatting, error handling and routing conventions. Read these authoritative backend handoffs in full:

- `/Users/anshumansharma/Documents/driver_feedback/PAYMENT_REVIEW_API.md`
- `/Users/anshumansharma/Documents/driver_feedback/FRONTEND_UNIFIED_PAYMENTS_REPORT.md`
- `/Users/anshumansharma/Documents/driver_feedback/payment-review-examples.json`

The review API document contains exact TypeScript-ready requests/responses, action rules, persisted reason codes, current blocker codes, errors and examples. Use those contracts; do not invent endpoints or infer accounting eligibility.

1. Add a Review action to gateway rows in the unified Payments report. Use the row's internal `paymentOrderId` to call `GET /api/v1/core/payment-orders/:orderId/review`. Make unresolved review and reversed-without-refund cases easy to find. All three Core roles may inspect; only CORE_ADMIN may resolve. Keep this workflow out of public booking and customer account pages.

2. Build a review screen or drawer showing order/provider/booking/customer/invoice references, actual received amount and currency, payment timestamps, current invoice balance, each safe attempt ID and provider payment reference, provider payment status separately from accounting status, persisted reviewReasons, linked receipts, current action blockers and immutable history. Explain UNKNOWN_LEGACY_REASON as “The original reason was not recorded”; show current eligibility separately without presenting it as the historical reason. Display reversed receipts as REVERSED_WITHOUT_REFUND when returned. A reversed receipt is not a verified refund.

3. Render allowed actions from each attempt's backend `actions` array. Disable unavailable decisions and explain their blockers. Viewers/data-entry staff must not receive resolution controls. Administrator controls must require a nonblank staff note and explicit confirmation of the selected attempt, amount/currency, invoice/receipt or external-refund evidence. Server authorization remains authoritative.

4. Submit `POST /api/v1/core/payment-attempts/:attemptId/resolve` with an Idempotency-Key and the current review `version`. Implement these three discriminated request bodies exactly:
   - APPLY_TO_LINKED_INVOICE: action, version, note.
   - LINK_EXISTING_RECEIPT: action, version, note, receiptId selected from matchingReceipts. Show receipt details and BACKEND_GATEWAY_RECEIPT_IDENTITY evidence. Do not offer arbitrary manual receipt IDs or infer matches from amount/reference text.
   - RECORD_VERIFIED_EXTERNAL_REFUND: action, version, note, refund containing providerRefundReference, exact full amount, exact payment currency, completedAt, and verification `{ kind: "STAFF_ATTESTATION", evidenceReference: "...", attested: true }`.

5. Refund UI must say “Record a completed external refund”, not “Issue refund”. The backend does not initiate refunds or independently verify them with the provider. Require an explicit administrator attestation checkbox, documentary evidence reference and provider refund reference. Do not pre-check attestation or silently submit it. Permit only full refunds; never represent a partial refund as resolved. Preserve original payment success and show refund verification kind, actor and recording timestamp separately. Warn using actual returned blockers when a confirmed/pending receipt prevents recording. Do not add a mark-reviewed or acknowledgement action.

6. Keep the original submitted body and idempotency key for uncertain network retries. Disable duplicate submissions. On PAYMENT_REVIEW_STALE, refetch and require another human confirmation before sending a new decision. On PAYMENT_ALREADY_RESOLVED, display the existing history. Do not silently create a new key/body after any conflict. Show actionable errors using the existing error envelope; handle 401/403 normally.

7. After success, replace the case with the returned fresh `review` and invalidate/refetch the unified payments report, summaries and any displayed booking/invoice balances. After linking, the previous receipt and order can collapse into one backend row; never deduplicate or synthesize this locally. Preserve active filters/pagination where practical. A remaining unresolved attempt keeps the order blocked even if one decision succeeded. Do not optimistically clear all review flags.

8. Correct the reconciliation identifier mismatch. For a report row's internal UUID, use `POST /api/v1/core/payment-orders/:orderId/reconcile-by-id`. CORE_ADMIN and CORE_DATA_ENTRY may retry provider checks; CORE_REPORT_VIEWER may only inspect. The legacy staff `/reconcile` and public booking `/orders/:orderId/reconcile` routes still require the `er_...` provider order reference. Label retry as a provider status check, separate from an accounting decision, and refresh the review afterwards.

9. Update report types and display for gatewayStatus REFUNDED, separate providerStatus, safe attempt IDs/reasons/receipt accounting state, safe resolutions, and recordedExternalRefundAmount in rows/full-filter summary. Keep providerConfirmedReviewAmount and confirmed receipt totals distinct. REFUNDED is a recorded local disposition; providerStatus/payment status can remain PAID/SUCCESS. recordedExternalRefundAmount reflects recorded external refunds in INR, not independently provider-verified refunds. Currency anomalies remain visible in details but must not be mixed into INR totals. Continue to use server CSV export and precise decimal strings.

10. Test inspection permissions, administrator-only decisions, applicable/unknown/additional/ineligible cases, candidate receipt selection, explicit full-refund attestation, stale conflicts and idempotent retries, reversed receipts without inferred refunds, report/summary refresh, remaining unresolved funds and the corrected UUID reconciliation route. Run repository checks and report results. If the updated backend is not running, identify that limitation explicitly without substituting receipt-only data or fabricated actions.
