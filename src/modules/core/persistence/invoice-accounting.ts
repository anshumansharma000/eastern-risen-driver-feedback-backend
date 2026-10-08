import { sql, type SQLWrapper } from 'drizzle-orm';
import { receipts, settlementAdjustments } from './billing.schema.js';

/** Same current balance basis as the invoice report: confirmed receipts and active adjustments. */
export function invoiceAccounting(id: SQLWrapper, status: SQLWrapper, grandTotal: SQLWrapper) {
  const received = sql`coalesce((select sum(r.amount) from ${receipts} r where r.invoice_id = ${id} and r.status = 'CONFIRMED'), 0)`;
  const adjusted = sql`coalesce((select sum(a.amount) from ${settlementAdjustments} a where a.invoice_id = ${id} and a.reversed_at is null), 0)`;
  const due = sql`case when ${status} = 'ISSUED' then ${grandTotal} - (${received}) - (${adjusted}) else 0 end`;
  return { received, adjusted, due };
}
