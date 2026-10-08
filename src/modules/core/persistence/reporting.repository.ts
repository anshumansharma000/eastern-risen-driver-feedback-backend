import { paymentOrderNeedsReview } from './payment-review-predicate.js';
import { paymentOrders } from './commercial.schema.js';
import { invoiceAccounting } from './invoice-accounting.js';
import { sql, type SQL } from 'drizzle-orm';
import type {
  AuditReportQuery,
  CommonReportQuery,
  CustomerStatementQuery,
  DashboardQuery,
  DiscountReportQuery,
  InvoiceReportQuery,
  PaymentReportQuery,
  ReceivablesReportQuery,
  TaxReportQuery,
  VehicleInvoiceReportQuery,
} from '../application/reporting.contracts.js';
import { invalid, missing } from '../domain/errors.js';
import { validateDate, validatePeriod } from '../domain/validation.js';
import {
  companies,
  coreAuditEvents,
  coreOutbox,
  customers,
  hotelRates,
  serviceCategories,
} from './masters.schema.js';
import {
  invoiceLines,
  invoiceLineTaxes,
  invoices,
  receipts,
  settlementAdjustments,
} from './billing.schema.js';
import type { CoreDatabase } from './database.js';

type Row = Record<string, unknown>;
type ReportResult = { items: Row[]; summary: Row; total: number };
type DateRange = { from?: string; to?: string };

const invoiceCustomerName = sql`coalesce(i.snapshot->'customer'->>'name', c.name)`;
const invoiceCustomerCategory = sql`coalesce(i.snapshot->'customer'->>'category', c.category::text)`;
const invoiceCategoryName = sql`coalesce(i.snapshot->'serviceCategory'->>'name', sc.name)`;
const invoiceVehicleRegistration = sql`nullif(i.snapshot->'vehicle'->>'registrationNumber', '')`;
const invoiceVehicleName = sql`nullif(coalesce(i.snapshot->'vehicle'->>'name', i.snapshot->'vehicle'->>'displayName'), '')`;
const invoiceVehicleType = sql`nullif(i.snapshot->'vehicle'->>'vehicleType', '')`;
const {
  received: invoiceReceived,
  adjusted: invoiceAdjusted,
  due: invoiceDue,
} = invoiceAccounting(sql`i.id`, sql`i.status`, sql`i.grand_total`);

function currentFinancialYear(): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)!.value);
  const year = value('year');
  const start = value('month') < 4 ? year - 1 : year;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

function range(input: { from?: string; to?: string }, useDefault = true): DateRange {
  const fallback = currentFinancialYear();
  const from = input.from ?? (useDefault ? fallback.from : undefined);
  const to = input.to ?? (useDefault ? fallback.to : undefined);
  if (from && to) validatePeriod(from, to);
  else if (from) validateDate(from);
  else if (to) validateDate(to);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function where(parts: SQL[]): SQL {
  return parts.length ? sql`where ${sql.join(parts, sql` and `)}` : sql``;
}

function pagination(input: { page?: number; pageSize?: number }) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 25;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function order(
  sortBy: string | undefined,
  sortOrder: 'asc' | 'desc' | undefined,
  fields: Record<string, string>,
  fallback: string,
) {
  const field = sortBy ? fields[sortBy] : undefined;
  if (sortBy && !field) throw invalid('Unsupported report sort field');
  return sql.raw(`${field ?? fallback} ${sortOrder ?? 'desc'}`);
}

export class ReportingRepository {
  constructor(private readonly db: CoreDatabase) {}

  private async rows<T extends Row>(query: SQL): Promise<T[]> {
    const result = await this.db.execute<T>(query);
    return result.rows as T[];
  }

  private invoiceConditions(
    input: CommonReportQuery & { status?: string },
    dateAlias = 'i.invoice_date',
  ) {
    const dates = range(input);
    const parts: SQL[] = [];
    if (dates.from) parts.push(sql`${sql.raw(dateAlias)} >= ${dates.from}`);
    if (dates.to) parts.push(sql`${sql.raw(dateAlias)} <= ${dates.to}`);
    if (input.companyId) parts.push(sql`i.company_id = ${input.companyId}`);
    if (input.customerId) parts.push(sql`i.customer_id = ${input.customerId}`);
    if (input.customerCategory)
      parts.push(sql`${invoiceCustomerCategory} = ${input.customerCategory}`);
    if (input.serviceCategoryId)
      parts.push(sql`i.service_category_id = ${input.serviceCategoryId}`);
    if (input.vehicleId) parts.push(sql`i.vehicle_id = ${input.vehicleId}`);
    if (input.status) parts.push(sql`i.status::text = ${input.status}`);
    if (input.q) {
      const term = `%${input.q.trim()}%`;
      parts.push(sql`(
        coalesce(i.invoice_number, '') ilike ${term}
        or ${invoiceCustomerName} ilike ${term}
        or coalesce(i.details->>'guestDisplayText', '') ilike ${term}
        or coalesce(${invoiceVehicleRegistration}, '') ilike ${term}
      )`);
    }
    return { parts, dates };
  }

  private invoiceRows(input: InvoiceReportQuery | ReceivablesReportQuery, issuedOnly = false) {
    const { parts, dates } = this.invoiceConditions({
      ...input,
      ...(issuedOnly ? { status: 'ISSUED' } : {}),
    });
    if ('financialYear' in input && input.financialYear)
      parts.push(sql`i.financial_year = ${input.financialYear}`);
    if ('hasVehicle' in input && input.hasVehicle !== undefined)
      parts.push(input.hasVehicle ? sql`i.vehicle_id is not null` : sql`i.vehicle_id is null`);
    const base = sql`
      select
        i.id as "invoiceId", i.invoice_date as "invoiceDate", i.financial_year as "financialYear",
        i.invoice_number as "invoiceNumber", i.status::text as status,
        i.company_id as "companyId", co.name as "companyName",
        i.customer_id as "customerId", ${invoiceCustomerName} as "customerName",
        ${invoiceCustomerCategory} as "customerCategory",
        i.service_category_id as "serviceCategoryId", ${invoiceCategoryName} as "serviceCategoryName",
        i.vehicle_id as "vehicleId", ${invoiceVehicleRegistration} as "vehicleRegistrationNumber",
        ${invoiceVehicleName} as "vehicleName", ${invoiceVehicleType} as "vehicleType",
        coalesce(i.details->>'guestDisplayText', '') as "guestDisplayText",
        nullif(i.details->>'dueDate', '')::date as "dueDate",
        i.subtotal::numeric(18,2)::text as subtotal, i.tax_total::numeric(18,2)::text as "taxTotal",
        i.grand_total::numeric(18,2)::text as "grandTotal",
        (${invoiceReceived})::numeric(18,2)::text as "receivedAmount",
        (${invoiceAdjusted})::numeric(18,2)::text as "adjustmentAmount",
        (${invoiceDue})::numeric(18,2)::text as "dueAmount",
        case
          when i.status <> 'ISSUED' then 'NOT_APPLICABLE'
          when i.grand_total - (${invoiceReceived}) - (${invoiceAdjusted}) = 0 then 'PAID'
          when (${invoiceReceived}) = 0 and (${invoiceAdjusted}) = 0 then 'UNPAID'
          else 'PARTIALLY_PAID'
        end as "paymentStatus",
        i.issued_at as "issuedAt", i.cancelled_at as "cancelledAt",
        i.cancellation_reason as "cancellationReason"
      from ${invoices} i
      join ${companies} co on co.id = i.company_id
      join ${customers} c on c.id = i.customer_id
      join ${serviceCategories} sc on sc.id = i.service_category_id
      ${where(parts)}`;
    return { base, dates };
  }

  async invoices(
    input: InvoiceReportQuery,
  ): Promise<ReportResult & { dates: ReturnType<typeof range> }> {
    const { base, dates } = this.invoiceRows(input);
    const outer: SQL[] = [];
    if (input.paymentStatus) outer.push(sql`r."paymentStatus" = ${input.paymentStatus}`);
    const filtered = sql`select * from (${base}) r ${where(outer)}`;
    const page = pagination(input);
    const sorting = order(
      input.sortBy,
      input.sortOrder,
      {
        invoiceDate: '"invoiceDate"',
        invoiceNumber: '"invoiceNumber"',
        customer: '"customerName"',
        customerCategory: '"customerCategory"',
        serviceCategory: '"serviceCategoryName"',
        vehicle: '"vehicleRegistrationNumber"',
        status: 'status',
        subtotal: 'subtotal::numeric',
        taxTotal: '"taxTotal"::numeric',
        grandTotal: '"grandTotal"::numeric',
        receivedAmount: '"receivedAmount"::numeric',
        adjustmentAmount: '"adjustmentAmount"::numeric',
        dueAmount: '"dueAmount"::numeric',
        dueDate: '"dueDate"',
      },
      '"invoiceDate"',
    );
    const [items, summaries] = await Promise.all([
      this.rows(
        sql`select * from (${filtered}) x order by ${sorting}, "invoiceId" desc limit ${page.pageSize} offset ${page.offset}`,
      ),
      this.rows(sql`select
        count(*)::integer as total,
        count(*) filter (where status = 'DRAFT')::integer as "draftCount",
        count(*) filter (where status = 'ISSUED')::integer as "issuedCount",
        count(*) filter (where status = 'CANCELLED')::integer as "cancelledCount",
        coalesce(sum(subtotal::numeric) filter (where status = 'ISSUED'), 0)::numeric(18,2)::text as subtotal,
        coalesce(sum("taxTotal"::numeric) filter (where status = 'ISSUED'), 0)::numeric(18,2)::text as "taxTotal",
        coalesce(sum("grandTotal"::numeric) filter (where status = 'ISSUED'), 0)::numeric(18,2)::text as "grandTotal",
        coalesce(sum("receivedAmount"::numeric) filter (where status = 'ISSUED'), 0)::numeric(18,2)::text as "receivedAmount",
        coalesce(sum("adjustmentAmount"::numeric) filter (where status = 'ISSUED'), 0)::numeric(18,2)::text as "adjustmentAmount",
        coalesce(sum("dueAmount"::numeric) filter (where status = 'ISSUED'), 0)::numeric(18,2)::text as "dueAmount"
        from (${filtered}) s`),
    ]);
    const summary = summaries[0] ?? { total: 0 };
    return { items, summary, total: Number(summary.total), dates };
  }

  async vehicleInvoices(
    input: VehicleInvoiceReportQuery,
  ): Promise<ReportResult & { dates: ReturnType<typeof range> }> {
    const { base, dates } = this.invoiceRows({ ...input, status: input.status ?? 'ISSUED' });
    const vehicleFilter = input.includeUnassigned ? sql`` : sql`where "vehicleId" is not null`;
    const grouped = sql`select
      "vehicleId", "vehicleRegistrationNumber", "vehicleName", "vehicleType",
      count(*)::integer as "invoiceCount",
      sum(subtotal::numeric)::numeric(18,2)::text as subtotal,
      sum("taxTotal"::numeric)::numeric(18,2)::text as "taxTotal",
      sum("grandTotal"::numeric)::numeric(18,2)::text as "grandTotal",
      sum("receivedAmount"::numeric)::numeric(18,2)::text as "receivedAmount",
      sum("adjustmentAmount"::numeric)::numeric(18,2)::text as "adjustmentAmount",
      sum("dueAmount"::numeric)::numeric(18,2)::text as "dueAmount",
      min("invoiceDate") as "firstInvoiceDate", max("invoiceDate") as "latestInvoiceDate"
      from (${base}) r ${vehicleFilter}
      group by "vehicleId", "vehicleRegistrationNumber", "vehicleName", "vehicleType"`;
    const page = pagination(input);
    const sorting = order(
      input.sortBy,
      input.sortOrder,
      {
        registrationNumber: '"vehicleRegistrationNumber"',
        vehicleName: '"vehicleName"',
        vehicleType: '"vehicleType"',
        invoiceCount: '"invoiceCount"',
        grandTotal: '"grandTotal"::numeric',
        receivedAmount: '"receivedAmount"::numeric',
        dueAmount: '"dueAmount"::numeric',
      },
      '"grandTotal"::numeric',
    );
    const [items, summaries] = await Promise.all([
      this.rows(
        sql`select * from (${grouped}) g order by ${sorting}, "vehicleId" nulls last limit ${page.pageSize} offset ${page.offset}`,
      ),
      this.rows(sql`select count(*)::integer as total,
        coalesce(sum("invoiceCount"),0)::integer as "invoiceCount",
        coalesce(sum(subtotal::numeric),0)::numeric(18,2)::text as subtotal,
        coalesce(sum("taxTotal"::numeric),0)::numeric(18,2)::text as "taxTotal",
        coalesce(sum("grandTotal"::numeric),0)::numeric(18,2)::text as "grandTotal",
        coalesce(sum("receivedAmount"::numeric),0)::numeric(18,2)::text as "receivedAmount",
        coalesce(sum("adjustmentAmount"::numeric),0)::numeric(18,2)::text as "adjustmentAmount",
        coalesce(sum("dueAmount"::numeric),0)::numeric(18,2)::text as "dueAmount"
        from (${grouped}) s`),
    ]);
    const summary = summaries[0] ?? { total: 0 };
    return { items, summary, total: Number(summary.total), dates };
  }

  async taxes(input: TaxReportQuery): Promise<ReportResult & { dates: ReturnType<typeof range> }> {
    const { parts, dates } = this.invoiceConditions({ ...input, status: input.status ?? 'ISSUED' });
    if (input.component) parts.push(sql`t.component = ${input.component}`);
    if (input.rate) parts.push(sql`t.rate = ${input.rate}::numeric`);
    const detail = sql`select
      t.id as "taxId", i.id as "invoiceId", i.invoice_date as "invoiceDate",
      i.invoice_number as "invoiceNumber", co.name as "companyName",
      ${invoiceCustomerName} as "customerName", ${invoiceCustomerCategory} as "customerCategory",
      ${invoiceCategoryName} as "serviceCategoryName", l.id as "lineId", l.position,
      l.description, l.amount::numeric(18,2)::text as "taxableBase", l.tax_treatment as "taxTreatment",
      t.component, t.rate::text as rate, t.amount::numeric(18,2)::text as "taxAmount"
      from ${invoiceLineTaxes} t
      join ${invoiceLines} l on l.id = t.line_id
      join ${invoices} i on i.id = l.invoice_id
      join ${companies} co on co.id = i.company_id
      join ${customers} c on c.id = i.customer_id
      join ${serviceCategories} sc on sc.id = i.service_category_id
      ${where(parts)}`;
    const groups = await this.rows(sql`select component, rate,
      "serviceCategoryName", count(distinct "invoiceId")::integer as "invoiceCount",
      count(*)::integer as "taxedLineCount",
      sum("taxAmount"::numeric)::numeric(18,2)::text as "taxAmount"
      from (${detail}) d group by component, rate, "serviceCategoryName"
      order by component, rate::numeric, "serviceCategoryName"`);
    const page = pagination(input);
    const sorting = order(
      input.sortBy,
      input.sortOrder,
      {
        component: 'component',
        rate: 'rate::numeric',
        serviceCategory: '"serviceCategoryName"',
        taxableBase: '"taxableBase"::numeric',
        taxAmount: '"taxAmount"::numeric',
      },
      '"invoiceDate"',
    );
    const [items, counts, baseTotals, taxTotals] = await Promise.all([
      this.rows(
        sql`select * from (${detail}) d order by ${sorting}, "taxId" desc limit ${page.pageSize} offset ${page.offset}`,
      ),
      this.rows(sql`select count(*)::integer as total from (${detail}) d`),
      this
        .rows(sql`select coalesce(sum("taxableBase"::numeric),0)::numeric(18,2)::text as "taxableBase"
        from (select distinct "lineId", "taxableBase" from (${detail}) d) lines`),
      this.rows(
        sql`select coalesce(sum("taxAmount"::numeric),0)::numeric(18,2)::text as "taxAmount" from (${detail}) d`,
      ),
    ]);
    const total = Number(counts[0]?.total ?? 0);
    return {
      items,
      total,
      dates,
      summary: {
        total,
        taxableBase: baseTotals[0]?.taxableBase ?? '0.00',
        taxAmount: taxTotals[0]?.taxAmount ?? '0.00',
        breakdown: groups,
      },
    };
  }

  async payments(
    input: PaymentReportQuery,
  ): Promise<ReportResult & { dates: ReturnType<typeof range> }> {
    const dates = range(input);
    const parts: SQL[] = [];
    if (dates.from) parts.push(sql`r.received_date >= ${dates.from}`);
    if (dates.to) parts.push(sql`r.received_date <= ${dates.to}`);
    if (input.companyId) parts.push(sql`i.company_id = ${input.companyId}`);
    if (input.customerId) parts.push(sql`i.customer_id = ${input.customerId}`);
    if (input.customerCategory)
      parts.push(sql`${invoiceCustomerCategory} = ${input.customerCategory}`);
    if (input.serviceCategoryId)
      parts.push(sql`i.service_category_id = ${input.serviceCategoryId}`);
    if (input.vehicleId) parts.push(sql`i.vehicle_id = ${input.vehicleId}`);
    if (input.status) parts.push(sql`r.status::text = ${input.status}`);
    if (input.method) parts.push(sql`r.method::text = ${input.method}`);
    if (input.q) {
      const term = `%${input.q.trim()}%`;
      parts.push(
        sql`(r.receipt_number ilike ${term} or coalesce(r.details->>'reference','') ilike ${term} or coalesce(i.invoice_number,'') ilike ${term} or ${invoiceCustomerName} ilike ${term})`,
      );
    }
    const base = sql`select r.id as "receiptId", r.received_date as "receivedDate",
      r.receipt_number as "receiptNumber", r.status::text as status, r.method::text as method,
      r.amount::numeric(18,2)::text as amount, r.details, r.created_by as "createdBy",
      r.created_at as "createdAt", r.updated_at as "updatedAt", r.reversal_reason as "reversalReason",
      i.id as "invoiceId", i.invoice_date as "invoiceDate", i.invoice_number as "invoiceNumber",
      i.company_id as "companyId", co.name as "companyName", i.customer_id as "customerId",
      ${invoiceCustomerName} as "customerName", ${invoiceCustomerCategory} as "customerCategory",
      i.service_category_id as "serviceCategoryId", ${invoiceCategoryName} as "serviceCategoryName"
      from ${receipts} r join ${invoices} i on i.id = r.invoice_id
      join ${companies} co on co.id = i.company_id join ${customers} c on c.id = i.customer_id
      join ${serviceCategories} sc on sc.id = i.service_category_id ${where(parts)}`;
    const page = pagination(input);
    const sorting = order(
      input.sortBy,
      input.sortOrder,
      {
        receivedDate: '"receivedDate"',
        receiptNumber: '"receiptNumber"',
        amount: 'amount::numeric',
        method: 'method',
        status: 'status',
        invoiceNumber: '"invoiceNumber"',
        customer: '"customerName"',
        createdAt: '"createdAt"',
      },
      '"receivedDate"',
    );
    const [items, summaries] = await Promise.all([
      this.rows(
        sql`select * from (${base}) p order by ${sorting}, "receiptId" desc limit ${page.pageSize} offset ${page.offset}`,
      ),
      this.rows(sql`select count(*)::integer as total,
        count(*) filter (where status='CONFIRMED')::integer as "confirmedCount",
        coalesce(sum(amount::numeric) filter (where status='CONFIRMED'),0)::numeric(18,2)::text as "confirmedAmount",
        count(*) filter (where status='PENDING')::integer as "pendingCount",
        coalesce(sum(amount::numeric) filter (where status='PENDING'),0)::numeric(18,2)::text as "pendingAmount",
        count(*) filter (where status='REVERSED')::integer as "reversedCount",
        coalesce(sum(amount::numeric) filter (where status='REVERSED'),0)::numeric(18,2)::text as "reversedAmount"
        from (${base}) p`),
    ]);
    const summary = summaries[0] ?? { total: 0 };
    return { items, summary, total: Number(summary.total), dates };
  }

  async receivables(
    input: ReceivablesReportQuery,
  ): Promise<ReportResult & { dates: ReturnType<typeof range> }> {
    if (input.dueFrom && input.dueTo) validatePeriod(input.dueFrom, input.dueTo);
    else if (input.dueFrom) validateDate(input.dueFrom);
    else if (input.dueTo) validateDate(input.dueTo);
    const { base, dates } = this.invoiceRows(input, true);
    const wrapped = sql`select r.*,
      case when "dueDate" is null then null else greatest(current_date - "dueDate", 0) end::integer as "daysOverdue",
      case
        when "dueDate" is null then 'NO_DUE_DATE'
        when "dueDate" >= current_date then 'NOT_DUE'
        when current_date - "dueDate" <= 30 then '1_30'
        when current_date - "dueDate" <= 60 then '31_60'
        when current_date - "dueDate" <= 90 then '61_90'
        else '90_PLUS'
      end as "ageingBucket",
      (select max(rr.received_date) from ${receipts} rr where rr.invoice_id = r."invoiceId" and rr.status='CONFIRMED') as "latestPaymentDate"
      from (${base}) r`;
    const conditions: SQL[] = [];
    if (input.paymentStatus) conditions.push(sql`x."paymentStatus" = ${input.paymentStatus}`);
    if (input.ageingBucket) conditions.push(sql`x."ageingBucket" = ${input.ageingBucket}`);
    if (input.overdueOnly)
      conditions.push(sql`x."dueAmount"::numeric > 0 and x."dueDate" < current_date`);
    if (input.dueFrom) conditions.push(sql`x."dueDate" >= ${input.dueFrom}`);
    if (input.dueTo) conditions.push(sql`x."dueDate" <= ${input.dueTo}`);
    const filtered = sql`select * from (${wrapped}) x ${where(conditions)}`;
    const page = pagination(input);
    const sorting = order(
      input.sortBy,
      input.sortOrder,
      {
        invoiceDate: '"invoiceDate"',
        dueDate: '"dueDate"',
        daysOverdue: '"daysOverdue"',
        invoiceNumber: '"invoiceNumber"',
        customer: '"customerName"',
        customerCategory: '"customerCategory"',
        serviceCategory: '"serviceCategoryName"',
        vehicle: '"vehicleRegistrationNumber"',
        grandTotal: '"grandTotal"::numeric',
        receivedAmount: '"receivedAmount"::numeric',
        adjustmentAmount: '"adjustmentAmount"::numeric',
        dueAmount: '"dueAmount"::numeric',
      },
      '"dueDate"',
    );
    const [items, summaries, buckets] = await Promise.all([
      this.rows(
        sql`select * from (${filtered}) r order by ${sorting} nulls last, "invoiceId" desc limit ${page.pageSize} offset ${page.offset}`,
      ),
      this.rows(sql`select count(*)::integer as total,
        coalesce(sum("grandTotal"::numeric),0)::numeric(18,2)::text as "grandTotal",
        coalesce(sum("receivedAmount"::numeric),0)::numeric(18,2)::text as "receivedAmount",
        coalesce(sum("adjustmentAmount"::numeric),0)::numeric(18,2)::text as "adjustmentAmount",
        coalesce(sum("dueAmount"::numeric),0)::numeric(18,2)::text as "dueAmount"
        from (${filtered}) r`),
      this.rows(sql`select "ageingBucket", count(*)::integer as "invoiceCount",
        count(*) filter(where "dueAmount"::numeric > 0)::integer as "outstandingInvoiceCount",
        sum("dueAmount"::numeric)::numeric(18,2)::text as "dueAmount"
        from (${filtered}) r group by "ageingBucket" order by "ageingBucket"`),
    ]);
    const summary: Row = { ...(summaries[0] ?? { total: 0 }), ageing: buckets };
    return { items, summary, total: Number(summary.total), dates };
  }

  async discounts(
    input: DiscountReportQuery,
  ): Promise<ReportResult & { dates: ReturnType<typeof range> }> {
    const dates = range(input);
    const parts: SQL[] = [];
    if (dates.from) parts.push(sql`a.date >= ${dates.from}`);
    if (dates.to) parts.push(sql`a.date <= ${dates.to}`);
    if (input.companyId) parts.push(sql`i.company_id = ${input.companyId}`);
    if (input.customerId) parts.push(sql`i.customer_id = ${input.customerId}`);
    if (input.customerCategory)
      parts.push(sql`${invoiceCustomerCategory} = ${input.customerCategory}`);
    if (input.serviceCategoryId)
      parts.push(sql`i.service_category_id = ${input.serviceCategoryId}`);
    if (input.vehicleId) parts.push(sql`i.vehicle_id = ${input.vehicleId}`);
    if (input.creatorId) parts.push(sql`a.created_by = ${input.creatorId}`);
    if (input.status === 'ACTIVE') parts.push(sql`a.reversed_at is null`);
    if (input.status === 'REVERSED') parts.push(sql`a.reversed_at is not null`);
    if (input.q) {
      const term = `%${input.q.trim()}%`;
      parts.push(
        sql`(a.reason ilike ${term} or coalesce(i.invoice_number,'') ilike ${term} or ${invoiceCustomerName} ilike ${term})`,
      );
    }
    const base = sql`select a.id as "adjustmentId", a.date, a.amount::numeric(18,2)::text as amount,
      a.reason, case when a.reversed_at is null then 'ACTIVE' else 'REVERSED' end as status,
      a.created_by as "createdBy", a.created_at as "createdAt", a.reversed_at as "reversedAt",
      a.reversal_reason as "reversalReason", i.id as "invoiceId", i.invoice_date as "invoiceDate",
      i.invoice_number as "invoiceNumber", i.grand_total::numeric(18,2)::text as "invoiceGrandTotal",
      co.name as "companyName", ${invoiceCustomerName} as "customerName",
      ${invoiceCustomerCategory} as "customerCategory", ${invoiceCategoryName} as "serviceCategoryName",
      (i.grand_total - (${invoiceReceived}) - (${invoiceAdjusted}))::numeric(18,2)::text as "currentDueAmount"
      from ${settlementAdjustments} a join ${invoices} i on i.id=a.invoice_id
      join ${companies} co on co.id=i.company_id join ${customers} c on c.id=i.customer_id
      join ${serviceCategories} sc on sc.id=i.service_category_id ${where(parts)}`;
    const page = pagination(input);
    const sorting = order(
      input.sortBy,
      input.sortOrder,
      {
        date: 'date',
        amount: 'amount::numeric',
        invoiceNumber: '"invoiceNumber"',
        customer: '"customerName"',
        customerCategory: '"customerCategory"',
        creator: '"createdBy"',
        reversedAt: '"reversedAt"',
      },
      'date',
    );
    const [items, summaries] = await Promise.all([
      this.rows(
        sql`select * from (${base}) d order by ${sorting}, "adjustmentId" desc limit ${page.pageSize} offset ${page.offset}`,
      ),
      this.rows(sql`select count(*)::integer as total,
        count(*) filter(where status='ACTIVE')::integer as "activeCount",
        coalesce(sum(amount::numeric) filter(where status='ACTIVE'),0)::numeric(18,2)::text as "activeAmount",
        count(*) filter(where status='REVERSED')::integer as "reversedCount",
        coalesce(sum(amount::numeric) filter(where status='REVERSED'),0)::numeric(18,2)::text as "reversedAmount"
        from (${base}) d`),
    ]);
    const summary = summaries[0] ?? { total: 0 };
    return { items, summary, total: Number(summary.total), dates };
  }

  async customerStatement(customerId: string, input: CustomerStatementQuery) {
    const dates = range(input);
    const [customer] = await this.rows<{ id: string; name: string; category: string }>(
      sql`select id, name, category::text as category from ${customers} where id=${customerId}`,
    );
    if (!customer) throw missing('Customer');
    const invoiceParts: SQL[] = [sql`i.customer_id=${customerId}`, sql`i.status='ISSUED'`];
    if (dates.from) invoiceParts.push(sql`i.invoice_date >= ${dates.from}`);
    if (dates.to) invoiceParts.push(sql`i.invoice_date <= ${dates.to}`);
    if (input.companyId) invoiceParts.push(sql`i.company_id=${input.companyId}`);
    if (input.includeSettled === false)
      invoiceParts.push(sql`i.grand_total - (${invoiceReceived}) - (${invoiceAdjusted}) > 0`);
    const entries = await this.rows(sql`
      with selected as (select i.* from ${invoices} i ${where(invoiceParts)})
      select * from (
        select i.invoice_date as date, 'INVOICE' as type, i.id as "documentId", i.invoice_number as "documentNumber",
          coalesce(i.details->>'guestDisplayText','') as description,
          i.grand_total::numeric(18,2)::text as debit, '0.00'::text as "cashCredit", '0.00'::text as "discountCredit"
        from selected i
        union all
        select r.received_date, 'RECEIPT', r.id, r.receipt_number,
          coalesce(r.details->>'reference', r.method::text), '0.00', r.amount::numeric(18,2)::text, '0.00'
        from ${receipts} r join selected i on i.id=r.invoice_id where r.status='CONFIRMED'
        union all
        select a.date, 'SETTLEMENT_DISCOUNT', a.id, null, a.reason, '0.00', '0.00', a.amount::numeric(18,2)::text
        from ${settlementAdjustments} a join selected i on i.id=a.invoice_id where a.reversed_at is null
      ) e order by date, case type when 'INVOICE' then 1 when 'RECEIPT' then 2 else 3 end, "documentId"`);
    const totals = await this.rows(sql`select
      coalesce(sum(i.grand_total),0)::numeric(18,2)::text as debit,
      coalesce(sum((${invoiceReceived})::numeric),0)::numeric(18,2)::text as "cashCredit",
      coalesce(sum((${invoiceAdjusted})::numeric),0)::numeric(18,2)::text as "discountCredit",
      coalesce(sum(i.grand_total - (${invoiceReceived}) - (${invoiceAdjusted})),0)::numeric(18,2)::text as "closingBalance"
      from ${invoices} i ${where(invoiceParts)}`);
    return {
      customer,
      entries,
      summary: totals[0] ?? {
        debit: '0.00',
        cashCredit: '0.00',
        discountCredit: '0.00',
        closingBalance: '0.00',
      },
      dates,
    };
  }

  async audit(
    input: AuditReportQuery,
  ): Promise<ReportResult & { dates: ReturnType<typeof range> }> {
    const dates = range(input, false);
    const parts: SQL[] = [];
    if (dates.from) parts.push(sql`created_at >= ${dates.from}::date`);
    if (dates.to) parts.push(sql`created_at < (${dates.to}::date + interval '1 day')`);
    if (input.actorId) parts.push(sql`actor_id=${input.actorId}`);
    if (input.action) parts.push(sql`action=${input.action}`);
    if (input.entityType) parts.push(sql`entity_type=${input.entityType}`);
    if (input.entityId) parts.push(sql`entity_id=${input.entityId}`);
    const page = pagination(input);
    const base = sql`select id, actor_id as "actorId", action, entity_type as "entityType",
      entity_id as "entityId", created_at as "createdAt" from ${coreAuditEvents} ${where(parts)}`;
    const [items, counts] = await Promise.all([
      this.rows(
        sql`select * from (${base}) a order by "createdAt" ${sql.raw(input.sortOrder ?? 'desc')}, id ${sql.raw(input.sortOrder ?? 'desc')} limit ${page.pageSize} offset ${page.offset}`,
      ),
      this.rows(sql`select count(*)::integer as total from (${base}) a`),
    ]);
    const total = Number(counts[0]?.total ?? 0);
    return { items, summary: { total }, total, dates };
  }

  async dashboard(input: DashboardQuery) {
    const dates = range(input);
    const invoiceInput: InvoiceReportQuery = {
      ...input,
      ...dates,
      status: 'ISSUED',
      page: 1,
      pageSize: 1,
    };
    const [
      invoiceReport,
      paymentReport,
      discountReport,
      ageing,
      categoryMix,
      serviceMix,
      topCustomers,
      paymentMethods,
      trend,
      recentActivity,
      alerts,
    ] = await Promise.all([
      this.invoices(invoiceInput),
      this.payments({
        ...input,
        ...dates,
        status: 'CONFIRMED',
        page: 1,
        pageSize: 1,
      }),
      this.discounts({
        ...input,
        ...dates,
        status: 'ACTIVE',
        page: 1,
        pageSize: 1,
      }),
      this.receivables({ ...input, ...dates, page: 1, pageSize: 1 }),
      this.dashboardGroup(input, dates, 'customer'),
      this.dashboardGroup(input, dates, 'service'),
      this.topOutstanding(input, dates),
      this.paymentMethodMix(input, dates),
      this.financialTrend(input, dates),
      this.recentActivity(),
      this.configurationAlerts(),
    ]);
    const grand = Number(invoiceReport.summary.grandTotal ?? 0);
    const receivedForCohort = Number(invoiceReport.summary.receivedAmount ?? 0);
    const adjustedForCohort = Number(invoiceReport.summary.adjustmentAmount ?? 0);
    return {
      period: dates,
      currency: 'INR',
      balanceBasis: 'CURRENT',
      generatedAt: new Date().toISOString(),
      cards: {
        issuedInvoiceCount: invoiceReport.summary.issuedCount,
        invoicedAmount: invoiceReport.summary.grandTotal,
        taxBilled: invoiceReport.summary.taxTotal,
        cashReceivedDuringPeriod: paymentReport.summary.confirmedAmount,
        outstandingNow: ageing.summary.dueAmount,
        settlementDiscountsDuringPeriod: discountReport.summary.activeAmount,
        overdueAmount: (ageing.summary.ageing as Row[])
          .filter((x) => !['NOT_DUE', 'NO_DUE_DATE'].includes(String(x.ageingBucket)))
          .reduce((sum, x) => sum + Number(x.dueAmount), 0)
          .toFixed(2),
        overdueInvoiceCount: (ageing.summary.ageing as Row[])
          .filter((x) => !['NOT_DUE', 'NO_DUE_DATE'].includes(String(x.ageingBucket)))
          .reduce((sum, x) => sum + Number(x.outstandingInvoiceCount), 0),
        cashCollectionRate: grand ? Number(((receivedForCohort / grand) * 100).toFixed(2)) : null,
        settlementCoverageRate: grand
          ? Number((((receivedForCohort + adjustedForCohort) / grand) * 100).toFixed(2))
          : null,
      },
      receivablesAgeing: ageing.summary.ageing,
      customerCategoryMix: categoryMix,
      serviceCategoryMix: serviceMix,
      topOutstandingCustomers: topCustomers,
      paymentMethodMix: paymentMethods,
      financialTrend: trend,
      recentActivity,
      alerts,
    };
  }

  private async dashboardGroup(
    input: DashboardQuery,
    dates: ReturnType<typeof range>,
    kind: 'customer' | 'service',
  ) {
    const { base } = this.invoiceRows({ ...input, ...dates, status: 'ISSUED' });
    const key = kind === 'customer' ? sql`"customerCategory"` : sql`"serviceCategoryName"`;
    return this.rows(sql`select ${key} as label, count(*)::integer as "invoiceCount",
      sum("grandTotal"::numeric)::numeric(18,2)::text as amount from (${base}) r
      group by ${key} order by sum("grandTotal"::numeric) desc, ${key}`);
  }

  private async topOutstanding(input: DashboardQuery, dates: ReturnType<typeof range>) {
    const { base } = this.invoiceRows({ ...input, ...dates, status: 'ISSUED' });
    return this.rows(sql`select "customerId", "customerName", "customerCategory",
      count(*) filter(where "dueAmount"::numeric > 0)::integer as "invoiceCount",
      sum("dueAmount"::numeric)::numeric(18,2)::text as "dueAmount",
      min("dueDate") filter(where "dueAmount"::numeric > 0) as "oldestDueDate"
      from (${base}) r group by "customerId", "customerName", "customerCategory"
      having sum("dueAmount"::numeric) > 0 order by sum("dueAmount"::numeric) desc limit 10`);
  }

  private async paymentMethodMix(input: DashboardQuery, dates: ReturnType<typeof range>) {
    const filters: SQL[] = [
      sql`r.status='CONFIRMED'`,
      sql`r.received_date >= ${dates.from}`,
      sql`r.received_date <= ${dates.to}`,
    ];
    if (input.companyId) filters.push(sql`i.company_id=${input.companyId}`);
    if (input.customerCategory)
      filters.push(sql`${invoiceCustomerCategory}=${input.customerCategory}`);
    if (input.serviceCategoryId)
      filters.push(sql`i.service_category_id=${input.serviceCategoryId}`);
    return this.rows(sql`select r.method::text as method, count(*)::integer as count,
      sum(r.amount)::numeric(18,2)::text as amount from ${receipts} r join ${invoices} i on i.id=r.invoice_id
      join ${customers} c on c.id=i.customer_id ${where(filters)} group by r.method order by sum(r.amount) desc`);
  }

  private async financialTrend(input: DashboardQuery, dates: DateRange) {
    const invoiceFilters: SQL[] = [
      sql`i.status='ISSUED'`,
      sql`i.invoice_date >= ${dates.from!}`,
      sql`i.invoice_date <= ${dates.to!}`,
    ];
    const receiptFilters: SQL[] = [
      sql`r.status='CONFIRMED'`,
      sql`r.received_date >= ${dates.from!}`,
      sql`r.received_date <= ${dates.to!}`,
    ];
    for (const filters of [invoiceFilters, receiptFilters]) {
      if (input.companyId) filters.push(sql`i.company_id=${input.companyId}`);
      if (input.customerCategory)
        filters.push(sql`${invoiceCustomerCategory}=${input.customerCategory}`);
      if (input.serviceCategoryId)
        filters.push(sql`i.service_category_id=${input.serviceCategoryId}`);
    }
    return this.rows(sql`select month,
      coalesce(sum("invoicedAmount"),0)::numeric(18,2)::text as "invoicedAmount",
      coalesce(sum("receivedAmount"),0)::numeric(18,2)::text as "receivedAmount"
      from (
        select to_char(i.invoice_date, 'YYYY-MM') as month, sum(i.grand_total) as "invoicedAmount", 0::numeric as "receivedAmount"
        from ${invoices} i join ${customers} c on c.id=i.customer_id
        ${where(invoiceFilters)} group by 1
        union all
        select to_char(r.received_date, 'YYYY-MM'), 0::numeric, sum(r.amount)
        from ${receipts} r join ${invoices} i on i.id=r.invoice_id join ${customers} c on c.id=i.customer_id
        ${where(receiptFilters)} group by 1
      ) series group by month order by month`);
  }

  private async recentActivity() {
    return this.rows(sql`select id, actor_id as "actorId", action,
      entity_type as "entityType", entity_id as "entityId", created_at as "createdAt"
      from ${coreAuditEvents}
      where action in ('ISSUED','CANCELLED','RECEIPT_CREATED','RECEIPT_CONFIRMED','RECEIPT_REVERSED',
        'SETTLEMENT_DISCOUNT_RECORDED','SETTLEMENT_DISCOUNT_REVERSED')
      order by created_at desc, id desc limit 10`);
  }

  private async configurationAlerts() {
    const rows = await this.rows(sql`select
      (select count(*) from ${paymentOrders} o where ${paymentOrderNeedsReview(sql`o`)})::integer as "paymentsRequiringReview",
      (select count(*) from ${invoices} where status='DRAFT' and created_at < now() - interval '30 days')::integer as "staleDrafts",
      (select count(*) from ${invoices} i where i.status='ISSUED' and nullif(i.details->>'dueDate','') is null and i.grand_total - (${invoiceReceived}) - (${invoiceAdjusted}) > 0)::integer as "receivablesWithoutDueDate",
      (select count(*) from ${companies} where status='ACTIVE' and (nullif(btrim(address),'') is null or nullif(btrim(state),'') is null or nullif(btrim(country),'') is null))::integer as "incompleteCompanies",
      (select count(*) from ${hotelRates} where status='ACTIVE' and effective_to between current_date and current_date + 30)::integer as "hotelRatesExpiringSoon",
      (select count(*) from ${coreOutbox} where published_at is null and created_at < now() - interval '1 hour')::integer as "staleOutboxEvents"`);
    return rows[0] ?? {};
  }
}
