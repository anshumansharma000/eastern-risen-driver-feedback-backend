import { paymentOrderNeedsReview } from './payment-review-predicate.js';
import { sql, type SQL } from 'drizzle-orm';
import type { UnifiedPaymentReportQuery } from '../application/reporting.contracts.js';
import { invalid } from '../domain/errors.js';
import { validateDate, validatePeriod } from '../domain/validation.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { CoreDatabase } from './database.js';
import { invoices, receipts } from './billing.schema.js';
import { companies, customers, serviceCategories } from './masters.schema.js';
import {
  commercialBookings,
  paymentOrders,
  paymentMilestones,
  paymentAttempts,
  paymentAttemptResolutions,
} from './commercial.schema.js';

type Row = Record<string, unknown>;
const sortFields: Record<string, string> = {
  activityAt: '"activityAt"',
  createdAt: '"createdAt"',
  receivedDate: '"receivedDate"',
  paidAt: '"paidAt"',
  amount: 'amount::numeric',
  source: 'source',
  method: 'method',
  receiptStatus: '"receiptStatus"',
  gatewayStatus: '"gatewayStatus"',
  receiptNumber: '"receiptNumber"',
  providerOrderId: '"providerOrderId"',
  invoiceNumber: '"invoiceNumber"',
  bookingReference: '"bookingReference"',
  customer: '"customerName"',
};

/** Orders own their receipt through persisted receipt FKs, never a method/reference heuristic. */
export class PaymentsReportRepository {
  constructor(private readonly db: CoreDatabase) {}

  async payments(input: UnifiedPaymentReportQuery, exporting = false) {
    if (input.from && input.to) validatePeriod(input.from, input.to);
    else if (input.from) validateDate(input.from);
    else if (input.to) validateDate(input.to);
    const field = sortFields[input.sortBy ?? 'activityAt'];
    if (!field) throw invalid('Unsupported report sort field');
    const direction = input.sortOrder ?? 'desc';
    if (!['asc', 'desc'].includes(direction)) throw invalid('Unsupported report sort order');
    const sorting = sql.raw(`${field} ${direction} nulls last, id desc`);
    const conditions: SQL[] = [];
    if (input.needsReview === true) conditions.push(sql`"needsReview" = true`);
    if (input.from) conditions.push(sql`"reportDate" >= ${input.from}::date`);
    if (input.to) conditions.push(sql`"reportDate" <= ${input.to}::date`);
    for (const key of [
      'source',
      'receiptStatus',
      'gatewayStatus',
      'method',
      'companyId',
      'customerId',
      'customerCategory',
      'serviceCategoryId',
    ] as const) {
      if (input[key]) conditions.push(sql`${sql.identifier(key)} = ${input[key]}`);
    }
    if (input.q) {
      // Search literal text, rather than allowing user-supplied LIKE wildcards.
      const term = `%${input.q.trim().replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(sql`(
        "receiptNumber" ilike ${term} or "providerOrderId" ilike ${term}
        or "providerPaymentId" ilike ${term} or "invoiceNumber" ilike ${term}
        or "bookingReference" ilike ${term} or "customerName" ilike ${term}
        or details->>'reference' ilike ${term}
        or exists (select 1 from ${paymentAttempts} a where a.order_id = "paymentOrderId" and a.provider_payment_id ilike ${term})
      )`);
    }
    const predicate = conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 25;
    // A single SQL statement gives the page, totals and export one consistent database snapshot.
    const result = await this.db.execute<{
      items: Row[];
      summary: Row & { total: number };
    }>(sql`
      with records as (
        select 'manual:' || r.id::text as id, 'MANUAL'::text as source, r.amount,
          r.created_at as "createdAt", r.received_date as "receivedDate", null::timestamptz as "paidAt",
          r.method::text as method, r.id as "receiptId", r.receipt_number as "receiptNumber",
          r.status::text as "receiptStatus", r.reversal_reason as "reversalReason", r.amount as "receiptAmount",
          null::uuid as "paymentOrderId", null::text as "gatewayStatus", null::text as provider,
          null::text as "providerOrderId", null::text as "providerPaymentId", null::text as "providerStatus",
          r.invoice_id as "invoiceId", b.id as "bookingId", b.reference as "bookingReference",
          i.company_id as "companyId", i.customer_id as "customerId", i.service_category_id as "serviceCategoryId",
          r.details, '[]'::jsonb as attempts, 0::numeric as "providerConfirmedReviewAmount",
          '[]'::jsonb as resolutions, 0::numeric as "recordedExternalRefundAmount", false as "needsReview"
        from ${receipts} r
        join ${invoices} i on i.id = r.invoice_id
        left join ${commercialBookings} b on b.invoice_id = i.id
        where not exists (select 1 from ${paymentOrders} o where o.receipt_id = r.id)
          and not exists (select 1 from ${paymentAttempts} a where a.receipt_id = r.id)
        union all
        select 'gateway:' || o.id::text, 'GATEWAY', o.amount,
          o.created_at, r.received_date, o.paid_at, r.method::text,
          r.id, r.receipt_number, r.status::text, r.reversal_reason, r.amount,
          o.id, o.status, o.provider, o.provider_order_id, o.provider_payment_id, o.provider_status,
          coalesce(r.invoice_id, b.invoice_id), b.id, b.reference,
          coalesce(i.company_id, b.company_id), coalesce(i.customer_id, b.customer_id),
          coalesce(i.service_category_id, b.service_category_id), coalesce(r.details, '{}'::jsonb),
          coalesce(a.attempts, '[]'::jsonb), coalesce(a.review_amount, 0),
          coalesce(res.resolutions, '[]'::jsonb), coalesce(a.refund_amount, 0), ${paymentOrderNeedsReview(sql`o`)}
        from ${paymentOrders} o
        left join ${paymentMilestones} m on m.id = o.milestone_id
        left join ${commercialBookings} b on b.id = m.booking_id
        left join ${receipts} r on r.id = coalesce(o.receipt_id, (
          select a.receipt_id from ${paymentAttempts} a
          where a.order_id = o.id and a.receipt_id is not null
          order by a.initiated_at desc, a.id desc limit 1
        ))
        left join ${invoices} i on i.id = coalesce(r.invoice_id, b.invoice_id)
        left join lateral (
          select jsonb_agg(jsonb_build_object(
            'id', a.id, 'providerPaymentId', a.provider_payment_id, 'status', a.status,
            'reviewReasons', case when a.accounting_status = 'REVIEW_REQUIRED' and a.review_reasons = '[]'::jsonb
              then '[{"code":"UNKNOWN_LEGACY_REASON","details":{}}]'::jsonb else a.review_reasons end,
            'receiptStatus', ar.status,
            'receiptAccountingState', case when ar.status = 'REVERSED' and a.accounting_status <> 'REFUNDED' then 'REVERSED_WITHOUT_REFUND' else ar.status::text end,
            'accountingStatus', a.accounting_status, 'amount', a.amount::text,
            'currency', a.currency, 'receiptId', a.receipt_id,
            'initiatedAt', a.initiated_at, 'completedAt', a.completed_at
          ) order by a.initiated_at desc, a.id desc) as attempts,
          sum(a.amount) filter (where a.status = 'SUCCESS' and (a.accounting_status = 'REVIEW_REQUIRED' or (a.accounting_status = 'APPLIED' and ar.status = 'REVERSED')) and a.currency = 'INR') as review_amount,
          sum(a.amount) filter (where a.status = 'SUCCESS' and a.accounting_status = 'REFUNDED' and a.currency = 'INR') as refund_amount
          from ${paymentAttempts} a left join ${receipts} ar on ar.id = a.receipt_id where a.order_id = o.id
        ) a on true
        left join lateral (
          select jsonb_agg(jsonb_build_object('id', d.id, 'attemptId', d.attempt_id, 'action', d.action,
            'actorId', d.actor_id, 'note', d.note, 'amount', d.amount::text, 'currency', d.currency,
            'receiptId', d.receipt_id, 'providerRefundReference', d.provider_refund_reference,
            'refund', d.refund, 'createdAt', d.created_at) order by d.created_at, d.id) as resolutions
          from ${paymentAttemptResolutions} d where d.order_id = o.id
        ) res on true
      ), enriched as (
        select p.*, i.invoice_number as "invoiceNumber", co.name as "companyName",
          coalesce(i.snapshot->'customer'->>'name', c.name) as "customerName",
          coalesce(i.snapshot->'customer'->>'category', c.category::text) as "customerCategory",
          coalesce(i.snapshot->'serviceCategory'->>'name', sc.name) as "serviceCategoryName",
          coalesce(p."paidAt", p."receivedDate"::timestamp at time zone 'Asia/Kolkata', p."createdAt") as "activityAt"
        from records p
        left join ${invoices} i on i.id = p."invoiceId"
        left join ${companies} co on co.id = p."companyId"
        left join ${customers} c on c.id = p."customerId"
        left join ${serviceCategories} sc on sc.id = p."serviceCategoryId"
      ), dated as (
        select *, ("activityAt" at time zone 'Asia/Kolkata')::date as "reportDate" from enriched
      ), filtered as materialized (select * from dated ${predicate}), summary as (
        select count(*)::integer as total,
          count(*) filter (where source = 'MANUAL')::integer as "manualCount",
          count(*) filter (where source = 'GATEWAY')::integer as "gatewayCount",
          count(*) filter (where "receiptStatus" = 'CONFIRMED')::integer as "confirmedReceiptCount",
          coalesce(sum("receiptAmount") filter (where "receiptStatus" = 'CONFIRMED'), 0)::text as "confirmedReceiptAmount",
          count(*) filter (where "receiptStatus" = 'PENDING')::integer as "pendingReceiptCount",
          coalesce(sum("receiptAmount") filter (where "receiptStatus" = 'PENDING'), 0)::text as "pendingReceiptAmount",
          count(*) filter (where "receiptStatus" = 'REVERSED')::integer as "reversedReceiptCount",
          coalesce(sum("receiptAmount") filter (where "receiptStatus" = 'REVERSED'), 0)::text as "reversedReceiptAmount",
          coalesce(sum("providerConfirmedReviewAmount"), 0)::text as "providerConfirmedReviewAmount",
          coalesce(sum("recordedExternalRefundAmount"), 0)::text as "recordedExternalRefundAmount"
        from filtered
      ), breakdown as (
        select "gatewayStatus" as status, count(*)::integer as count, sum(amount)::text as amount
        from filtered where source = 'GATEWAY' group by "gatewayStatus"
      ), page as (
        select * from filtered
        where not ${exporting} or (select total from summary) <= 100000
        order by ${sorting} limit ${exporting ? 100000 : pageSize} offset ${exporting ? 0 : (page - 1) * pageSize}
      )
      select
        coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
          'amount', p.amount::text, 'receiptAmount', p."receiptAmount"::text,
          'providerConfirmedReviewAmount', p."providerConfirmedReviewAmount"::text,
          'recordedExternalRefundAmount', p."recordedExternalRefundAmount"::text,
          'details', jsonb_strip_nulls(jsonb_build_object(
            'reference', p.details->>'reference', 'bankName', p.details->>'bankName',
            'instrumentDate', p.details->>'instrumentDate', 'cardLastFour', p.details->>'cardLastFour'
          ))
        ) order by ${sorting}) from page p), '[]'::jsonb) as items,
        (select to_jsonb(s) || jsonb_build_object('gatewayStatusBreakdown',
          coalesce((select jsonb_agg(b order by status) from breakdown b), '[]'::jsonb)) from summary s) as summary
    `);
    const { items, summary } = result.rows[0]!;
    // PostgreSQL numeric arithmetic is exact. Normalize zero aggregates to the decimal-string convention.
    for (const key of [
      'confirmedReceiptAmount',
      'pendingReceiptAmount',
      'reversedReceiptAmount',
      'providerConfirmedReviewAmount',
      'recordedExternalRefundAmount',
    ]) {
      if (summary[key] === '0') summary[key] = '0.00';
    }
    for (const item of items) {
      if (item.providerConfirmedReviewAmount === '0') item.providerConfirmedReviewAmount = '0.00';
      if (item.recordedExternalRefundAmount === '0') item.recordedExternalRefundAmount = '0.00';
    }
    if (exporting && summary.total > 100000)
      throw new AppError({
        code: 'REPORT_EXPORT_TOO_LARGE',
        message: 'Narrow the report filters before exporting more than 100,000 rows',
        statusCode: 413,
      });
    return {
      items,
      summary,
      total: summary.total,
      dates: {
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
      },
    };
  }
}
