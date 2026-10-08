import { sql, type SQL } from 'drizzle-orm';
import { paymentAttempts } from './commercial.schema.js';
import { receipts } from './billing.schema.js';

/** Unresolved order markers and attempt accounting cases, independent of order payment status.
 * Receipt fallback matches the review API's legacy order-level attribution.
 * Pending/unknown attempts require attention when reconciliation has marked their order.
 * Historical reason arrays and refund amounts are not current unresolved state.
 */
export function paymentOrderNeedsReview(order: SQL): SQL<boolean> {
  return sql<boolean>`(${order}.status = 'REVIEW_REQUIRED' or ${order}.review_required_at is not null
    or exists (
      select 1 from ${paymentAttempts} review_a
      left join ${receipts} review_r on review_r.id = coalesce(review_a.receipt_id,
        case when review_a.provider_payment_id = ${order}.provider_payment_id then ${order}.receipt_id end)
      where review_a.order_id = ${order}.id and (
        review_a.accounting_status = 'REVIEW_REQUIRED'
        or (review_a.accounting_status = 'APPLIED' and review_r.status = 'REVERSED')
      )
    ))`;
}
