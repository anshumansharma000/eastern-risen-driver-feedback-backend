import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { CoreDatabase } from './database.js';
import { guests } from './masters.schema.js';
import { invoices, receipts, settlementAdjustments } from './billing.schema.js';
import { missing } from '../domain/errors.js';
export class ReportsRepository {
  constructor(private readonly db: CoreDatabase) {}
  async receivables(page: number, pageSize: number) {
    // Correlated aggregates avoid multiplying receipts by adjustments in a join.
    const received = sql<string>`coalesce((select sum(r.amount) from ${receipts} r where r.invoice_id = ${invoices.id} and r.status = 'CONFIRMED'),0)::numeric(18,2)::text`;
    const adjusted = sql<string>`coalesce((select sum(a.amount) from ${settlementAdjustments} a where a.invoice_id = ${invoices.id} and a.reversed_at is null),0)::numeric(18,2)::text`;
    const rows = await this.db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        companyId: invoices.companyId,
        customerId: invoices.customerId,
        invoiceDate: invoices.invoiceDate,
        grandTotal: invoices.grandTotal,
        receivedAmount: received,
        adjustmentAmount: adjusted,
        dueAmount: sql<string>`(${invoices.grandTotal} - (${received})::numeric - (${adjusted})::numeric)::numeric(18,2)::text`,
        total: sql<number>`count(*) over()::integer`,
      })
      .from(invoices)
      .where(eq(invoices.status, 'ISSUED'))
      .orderBy(desc(invoices.invoiceDate), desc(invoices.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const total =
      rows[0]?.total ??
      (
        await this.db.select({ value: count() }).from(invoices).where(eq(invoices.status, 'ISSUED'))
      )[0]!.value;
    return { items: rows, total };
  }
  async guestActivity(id: string) {
    const [guest] = await this.db.select().from(guests).where(eq(guests.id, id));
    if (!guest) throw missing('Guest');
    const [service] = await this.db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        date: invoices.invoiceDate,
        details: invoices.details,
      })
      .from(invoices)
      .where(and(eq(invoices.guestId, id), eq(invoices.status, 'ISSUED')))
      .orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt), desc(invoices.id))
      .limit(1);
    const [payment] = await this.db
      .select({
        receiptId: receipts.id,
        invoiceId: invoices.id,
        date: receipts.receivedDate,
        amount: receipts.amount,
      })
      .from(receipts)
      .innerJoin(invoices, eq(invoices.id, receipts.invoiceId))
      .where(
        and(
          eq(invoices.guestId, id),
          eq(invoices.status, 'ISSUED'),
          eq(receipts.status, 'CONFIRMED'),
        ),
      )
      .orderBy(desc(receipts.receivedDate), desc(receipts.createdAt), desc(receipts.id))
      .limit(1);
    return {
      guestId: id,
      lastService: service
        ? {
            invoiceId: service.invoiceId,
            invoiceNumber: service.invoiceNumber,
            date: service.date,
            descriptions: service.details.lines.map((line) => line.description),
          }
        : null,
      lastPayment: payment ?? null,
      legacyLastServiceAvailed: guest.legacyLastServiceAvailed,
      legacyLastAmountPaid: guest.legacyLastAmountPaid,
    };
  }
}
