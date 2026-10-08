import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { Type } from 'typebox';
import { AppError } from '../../../shared/errors/app-error.js';
import type { CoreServices } from '../index.js';
import { paramsSchema, uuidSchema } from './masters.schemas.js';
import * as schemas from './reports.schemas.js';

const nullableText = Type.Union([Type.String(), Type.Null()]);

function meta(dateBasis: string, dates: { from?: string; to?: string }) {
  return {
    currency: 'INR' as const,
    dateBasis,
    from: dates.from ?? null,
    to: dates.to ?? null,
    balanceBasis: 'CURRENT' as const,
    generatedAt: new Date().toISOString(),
  };
}

function envelope(
  result: {
    items: Record<string, unknown>[];
    summary: Record<string, unknown>;
    total: number;
    dates: { from?: string; to?: string };
  },
  query: { page?: number; pageSize?: number },
  dateBasis: string,
) {
  return {
    data: result.items,
    summary: result.summary,
    pagination: { page: query.page ?? 1, pageSize: query.pageSize ?? 25, total: result.total },
    meta: meta(dateBasis, result.dates),
  };
}

async function collectRows(
  fetchPage: (
    page: number,
    pageSize: number,
  ) => Promise<{
    items: Record<string, unknown>[];
    total: number;
  }>,
) {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  for (let page = 1; ; page += 1) {
    const result = await fetchPage(page, pageSize);
    if (result.total > 100_000)
      throw new AppError({
        code: 'REPORT_EXPORT_TOO_LARGE',
        message: 'Narrow the report filters before exporting more than 100,000 rows',
        statusCode: 413,
      });
    rows.push(...result.items);
    if (rows.length >= result.total || result.items.length === 0) return rows;
  }
}

function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    text = value.toString();
  else text = JSON.stringify(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

interface CsvColumn {
  key: string;
  header: string;
}

const invoiceRegisterCsvColumns: CsvColumn[] = [
  { key: 'invoiceDate', header: 'Invoice Date' },
  { key: 'financialYear', header: 'Financial Year' },
  { key: 'invoiceNumber', header: 'Invoice Number' },
  { key: 'status', header: 'Invoice Status' },
  { key: 'companyName', header: 'Company' },
  { key: 'customerName', header: 'Customer' },
  { key: 'customerCategory', header: 'Customer Category' },
  { key: 'serviceCategoryName', header: 'Service Category' },
  { key: 'vehicleRegistrationNumber', header: 'Vehicle Registration Number' },
  { key: 'vehicleName', header: 'Vehicle Name' },
  { key: 'vehicleType', header: 'Vehicle Type' },
  { key: 'guestDisplayText', header: 'Guest' },
  { key: 'dueDate', header: 'Due Date' },
  { key: 'subtotal', header: 'Subtotal (INR)' },
  { key: 'taxTotal', header: 'Tax Total (INR)' },
  { key: 'grandTotal', header: 'Grand Total (INR)' },
  { key: 'receivedAmount', header: 'Received Amount (INR)' },
  { key: 'adjustmentAmount', header: 'Settlement Discount (INR)' },
  { key: 'dueAmount', header: 'Due Amount (INR)' },
  { key: 'paymentStatus', header: 'Payment Status' },
  { key: 'cancellationReason', header: 'Cancellation Reason' },
];

const vehicleInvoiceCsvColumns: CsvColumn[] = [
  { key: 'vehicleRegistrationNumber', header: 'Vehicle Registration Number' },
  { key: 'vehicleName', header: 'Vehicle Name' },
  { key: 'vehicleType', header: 'Vehicle Type' },
  { key: 'invoiceCount', header: 'Invoice Count' },
  { key: 'subtotal', header: 'Subtotal (INR)' },
  { key: 'taxTotal', header: 'Tax Total (INR)' },
  { key: 'grandTotal', header: 'Grand Total (INR)' },
  { key: 'receivedAmount', header: 'Received Amount (INR)' },
  { key: 'adjustmentAmount', header: 'Settlement Discount (INR)' },
  { key: 'dueAmount', header: 'Due Amount (INR)' },
  { key: 'firstInvoiceDate', header: 'First Invoice Date' },
  { key: 'latestInvoiceDate', header: 'Latest Invoice Date' },
];

const paymentCsvColumns: CsvColumn[] = [
  'id',
  'source',
  'amount',
  'activityAt',
  'reportDate',
  'createdAt',
  'receivedDate',
  'paidAt',
  'method',
  'receiptId',
  'receiptNumber',
  'receiptStatus',
  'receiptAmount',
  'reversalReason',
  'paymentOrderId',
  'gatewayStatus',
  'provider',
  'providerOrderId',
  'providerPaymentId',
  'providerStatus',
  'providerConfirmedReviewAmount',
  'invoiceId',
  'invoiceNumber',
  'bookingId',
  'bookingReference',
  'companyId',
  'companyName',
  'customerId',
  'customerName',
  'customerCategory',
  'serviceCategoryId',
  'serviceCategoryName',
  'details',
  'attempts',
  'resolutions',
  'recordedExternalRefundAmount',
].map((key) => ({ key, header: key }));

function csv(rows: Record<string, unknown>[], columns?: CsvColumn[]) {
  const selectedColumns =
    columns ??
    [...new Set(rows.flatMap((row) => Object.keys(row)))].map((key) => ({ key, header: key }));
  if (!selectedColumns.length) return '';
  return [
    selectedColumns.map((column) => csvCell(column.header)).join(','),
    ...rows.map((row) => selectedColumns.map((column) => csvCell(row[column.key])).join(',')),
  ].join('\r\n');
}

function sendCsv(
  reply: FastifyReply,
  rows: Record<string, unknown>[],
  name: string,
  columns?: CsvColumn[],
) {
  return reply
    .header('content-disposition', `attachment; filename="${name}.csv"`)
    .type('text/csv; charset=utf-8')
    .send(`\uFEFF${csv(rows, columns)}`);
}

export const reportRoutes: FastifyPluginAsyncTypebox<{ services: CoreServices }> = async (
  app,
  { services },
) => {
  app.addHook('preHandler', services.guards.read);

  app.get(
    '/reports/payments',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Get manual receipts and gateway orders across all states',
        querystring: schemas.unifiedPaymentReportQuery,
        response: { 200: schemas.reportEnvelope },
      },
    },
    async (request) =>
      envelope(
        await services.paymentsReport.payments(request.query),
        request.query,
        'PAYMENT_ACTIVITY_IST',
      ),
  );

  app.get(
    '/reports/payments/export',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Export the unified payments report as CSV',
        querystring: schemas.unifiedPaymentReportQuery,
      },
    },
    async (request, reply) =>
      sendCsv(
        reply,
        (await services.paymentsReport.payments(request.query, true)).items,
        'payments',
        paymentCsvColumns,
      ),
  );

  app.get(
    '/reports/dashboard',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Get Core financial and receivables dashboard analytics',
        querystring: schemas.dashboardQuery,
        response: { 200: schemas.dashboardEnvelope },
      },
    },
    async (request) => ({ data: await services.reporting.dashboard(request.query) }),
  );

  app.get(
    '/reports/invoices',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Get the filtered invoice register',
        querystring: schemas.invoiceReportQuery,
        response: { 200: schemas.reportEnvelope },
      },
    },
    async (request) =>
      envelope(await services.reporting.invoices(request.query), request.query, 'INVOICE_DATE'),
  );

  app.get(
    '/reports/invoices/export',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Export the filtered invoice register as CSV',
        querystring: schemas.invoiceReportQuery,
      },
    },
    async (request, reply) =>
      sendCsv(
        reply,
        await collectRows((page, pageSize) =>
          services.reporting.invoices({ ...request.query, page, pageSize }),
        ),
        'invoice-register',
        invoiceRegisterCsvColumns,
      ),
  );

  app.get(
    '/reports/vehicle-invoices',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Get vehicle-wise invoice totals',
        querystring: schemas.vehicleInvoiceReportQuery,
        response: { 200: schemas.reportEnvelope },
      },
    },
    async (request) =>
      envelope(
        await services.reporting.vehicleInvoices(request.query),
        request.query,
        'INVOICE_DATE',
      ),
  );

  app.get(
    '/reports/vehicle-invoices/export',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Export vehicle-wise invoice totals as CSV',
        querystring: schemas.vehicleInvoiceReportQuery,
      },
    },
    async (request, reply) =>
      sendCsv(
        reply,
        await collectRows((page, pageSize) =>
          services.reporting.vehicleInvoices({ ...request.query, page, pageSize }),
        ),
        'vehicle-invoices',
        vehicleInvoiceCsvColumns,
      ),
  );

  app.get(
    '/reports/taxes',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Get applied-tax detail and grouped totals',
        querystring: schemas.taxReportQuery,
        response: { 200: schemas.reportEnvelope },
      },
    },
    async (request) =>
      envelope(await services.reporting.taxes(request.query), request.query, 'INVOICE_DATE'),
  );

  app.get(
    '/reports/taxes/export',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Export applied-tax detail as CSV',
        querystring: schemas.taxReportQuery,
      },
    },
    async (request, reply) =>
      sendCsv(
        reply,
        await collectRows((page, pageSize) =>
          services.reporting.taxes({ ...request.query, page, pageSize }),
        ),
        'tax-detail',
      ),
  );

  app.get(
    '/reports/payments-received',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Get receipt and payment totals',
        querystring: schemas.paymentReportQuery,
        response: { 200: schemas.reportEnvelope },
      },
    },
    async (request) =>
      envelope(await services.reporting.payments(request.query), request.query, 'RECEIPT_DATE'),
  );

  app.get(
    '/reports/payments-received/export',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Export the payments-received report as CSV',
        querystring: schemas.paymentReportQuery,
      },
    },
    async (request, reply) =>
      sendCsv(
        reply,
        await collectRows((page, pageSize) =>
          services.reporting.payments({ ...request.query, page, pageSize }),
        ),
        'payments-received',
      ),
  );

  app.get(
    '/reports/receivables',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Get current receivables and ageing',
        querystring: schemas.receivablesReportQuery,
        response: { 200: schemas.reportEnvelope },
      },
    },
    async (request) =>
      envelope(await services.reporting.receivables(request.query), request.query, 'INVOICE_DATE'),
  );

  app.get(
    '/reports/receivables/export',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Export current receivables as CSV',
        querystring: schemas.receivablesReportQuery,
      },
    },
    async (request, reply) =>
      sendCsv(
        reply,
        await collectRows((page, pageSize) =>
          services.reporting.receivables({ ...request.query, page, pageSize }),
        ),
        'receivables',
      ),
  );

  app.get(
    '/reports/settlement-discounts',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Get active and reversed settlement discounts',
        querystring: schemas.discountReportQuery,
        response: { 200: schemas.reportEnvelope },
      },
    },
    async (request) =>
      envelope(await services.reporting.discounts(request.query), request.query, 'ADJUSTMENT_DATE'),
  );

  app.get(
    '/reports/settlement-discounts/export',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Export settlement discounts as CSV',
        querystring: schemas.discountReportQuery,
      },
    },
    async (request, reply) =>
      sendCsv(
        reply,
        await collectRows((page, pageSize) =>
          services.reporting.discounts({ ...request.query, page, pageSize }),
        ),
        'settlement-discounts',
      ),
  );

  app.get(
    '/reports/customers/:id/statement',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Get an invoice-linked customer statement',
        params: paramsSchema,
        querystring: schemas.customerStatementQuery,
        response: { 200: schemas.statementEnvelope },
      },
    },
    async (request) => ({
      data: await services.reporting.customerStatement(request.params.id, request.query),
    }),
  );

  app.get(
    '/reports/customers/:id/statement/export',
    {
      schema: {
        tags: ['core reports'],
        summary: 'Export a customer statement as CSV',
        params: paramsSchema,
        querystring: schemas.customerStatementQuery,
      },
    },
    async (request, reply) => {
      const statement = await services.reporting.customerStatement(
        request.params.id,
        request.query,
      );
      return sendCsv(reply, statement.entries, 'customer-statement');
    },
  );

  app.get(
    '/reports/audit',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core reports'],
        summary: 'Get Core audit activity (Core Admin only)',
        querystring: schemas.auditReportQuery,
        response: { 200: schemas.reportEnvelope },
      },
    },
    async (request) =>
      envelope(await services.reporting.audit(request.query), request.query, 'EVENT_TIMESTAMP'),
  );

  app.get(
    '/reports/audit/export',
    {
      preHandler: services.guards.admin,
      schema: {
        tags: ['core reports'],
        summary: 'Export Core audit activity as CSV (Core Admin only)',
        querystring: schemas.auditReportQuery,
      },
    },
    async (request, reply) =>
      sendCsv(
        reply,
        await collectRows((page, pageSize) =>
          services.reporting.audit({ ...request.query, page, pageSize }),
        ),
        'core-audit',
      ),
  );

  app.get(
    '/guests/:id/activity',
    {
      schema: {
        tags: ['core reports'],
        params: paramsSchema,
        response: {
          200: Type.Object({
            data: Type.Object({
              guestId: uuidSchema,
              lastService: Type.Union([
                Type.Object({
                  invoiceId: uuidSchema,
                  invoiceNumber: nullableText,
                  date: Type.String(),
                  descriptions: Type.Array(Type.String()),
                }),
                Type.Null(),
              ]),
              lastPayment: Type.Union([
                Type.Object({
                  receiptId: uuidSchema,
                  invoiceId: uuidSchema,
                  date: Type.String(),
                  amount: Type.String(),
                }),
                Type.Null(),
              ]),
              legacyLastServiceAvailed: nullableText,
              legacyLastAmountPaid: nullableText,
            }),
          }),
        },
      },
    },
    async (request) => ({ data: await services.reports.guestActivity(request.params.id) }),
  );
};
