import { and, eq, getTableColumns, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { CoreDatabase } from './database.js';
import type { BookingListQuery, BookingListRow } from '../http/booking-list.schemas.js';
import { validateDate, validatePeriod } from '../domain/validation.js';
import { commercialBookings, commercialQuotes } from './commercial.schema.js';
import { customers } from './masters.schema.js';
import { invoices } from './billing.schema.js';
import { invoiceAccounting } from './invoice-accounting.js';
import { textSearch } from '../../../shared/database/search.js';

export class CommercialBookingListRepository {
  constructor(private readonly db: CoreDatabase) {}
  async list(input: BookingListQuery) {
    if (input.serviceStartsFrom) validatePeriod(input.serviceStartsFrom, input.serviceStartsTo);
    else if (input.serviceStartsTo) validateDate(input.serviceStartsTo);
    const latest = this.db
      .select({
        bookingId: commercialQuotes.bookingId,
        version: commercialQuotes.version,
        acceptedAt: commercialQuotes.acceptedAt,
      })
      .from(commercialQuotes)
      .where(
        sql`not exists (select 1 from ${commercialQuotes} newer where newer.booking_id = ${commercialQuotes.bookingId} and newer.version > ${commercialQuotes.version})`,
      )
      .as('latest');
    const balance = invoiceAccounting(invoices.id, invoices.status, invoices.grandTotal);
    // The access token hash is private credential material, never needed by list consumers.
    const columns = getTableColumns(commercialBookings);
    const safeColumns = Object.fromEntries(
      Object.entries(columns)
        .filter(([key]) => key !== 'accessTokenHash')
        .map(([key, column]) => [key, sql`${column}`.as(key)]),
    );
    const query = this.db
      .select({
        ...safeColumns,
        customerName: sql`${customers.name}`.as('customerName'),
        latestQuoteVersion: sql`${latest.version}`.as('latestQuoteVersion'),
        latestQuoteAcceptedAt: sql`${latest.acceptedAt}`.as('latestQuoteAcceptedAt'),
        invoiceNumber: sql`${invoices.invoiceNumber}`.as('invoiceNumber'),
        receivedAmount: sql<
          string | null
        >`case when ${invoices.id} is null then null else (${balance.received})::numeric(18,2)::text end`.as(
          'receivedAmount',
        ),
        dueAmount: sql<
          string | null
        >`case when ${invoices.id} is null then null else (${balance.due})::numeric(18,2)::text end`.as(
          'dueAmount',
        ),
      })
      .from(commercialBookings)
      .leftJoin(customers, eq(customers.id, commercialBookings.customerId))
      .leftJoin(latest, eq(latest.bookingId, commercialBookings.id))
      .leftJoin(invoices, eq(invoices.id, commercialBookings.invoiceId))
      .where(
        and(
          textSearch(input.q, [
            commercialBookings.reference,
            commercialBookings.title,
            customers.name,
          ]),
          input.status ? eq(commercialBookings.status, input.status) : undefined,
          input.companyId ? eq(commercialBookings.companyId, input.companyId) : undefined,
          input.customerId ? eq(commercialBookings.customerId, input.customerId) : undefined,
          input.serviceStartsFrom
            ? gte(commercialBookings.serviceStartsOn, input.serviceStartsFrom)
            : undefined,
          input.serviceStartsTo
            ? lte(commercialBookings.serviceStartsOn, input.serviceStartsTo)
            : undefined,
          input.quoteAcceptance === 'NONE'
            ? isNull(latest.version)
            : input.quoteAcceptance === 'ACCEPTED'
              ? isNotNull(latest.acceptedAt)
              : input.quoteAcceptance === 'AWAITING_ACCEPTANCE'
                ? and(isNotNull(latest.version), isNull(latest.acceptedAt))
                : undefined,
        ),
      );
    const page = input.page ?? 1,
      pageSize = input.pageSize ?? 25;
    // One snapshot for the count and page, including empty/out-of-range pages.
    const result = await this.db.execute<{ items: BookingListRow[]; total: number }>(sql`
      with filtered as materialized (${query}), page as (
        select * from filtered order by "createdAt" desc, id desc limit ${pageSize} offset ${(page - 1) * pageSize}
      ) select coalesce((select jsonb_agg(p order by p."createdAt" desc, p.id desc) from page p), '[]'::jsonb) as items,
        (select count(*)::integer from filtered) as total
    `);
    const response = result.rows[0]!;
    for (const item of response.items) {
      for (const key of ['createdAt', 'updatedAt', 'latestQuoteAcceptedAt'] as const) {
        if (typeof item[key] === 'string') item[key] = new Date(item[key]).toISOString();
      }
    }
    return response;
  }
}
