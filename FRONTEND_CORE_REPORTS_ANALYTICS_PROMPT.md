# Frontend implementation prompt: Core reports and basic analytics

Update the existing Eastern Risen Core Admin frontend to implement the completed
Core reporting API. Work inside the established Next.js App Router, strict
TypeScript and Tailwind architecture. Reuse the existing authenticated API client,
session handling, layouts, tables, filters, form controls, status treatments,
loading states and design tokens. Do not create a disconnected demo, mock dashboard,
parallel application, or client-side reporting database.

The backend implementation and OpenAPI document are authoritative. All paths below
are relative to `/api/v1/core`. Requests use the existing secure session cookie and
must include credentials through the existing API client.

## Outcome

Deliver working pages for:

1. Core Overview dashboard
2. Invoice Register
3. Vehicle-wise Invoices
4. Tax Report
5. Payments Received
6. Payment Due / Receivables
7. Settlement Discounts
8. Customer Statement
9. Core Audit Activity, visible only to `CORE_ADMIN`

Every table must use server-side filters, sorting and pagination. Every supported
CSV button must call the server export endpoint with the same active filters. Never
calculate full-report totals from the current page.

## Navigation

Use the existing Core shell. Add or update these navigation destinations:

- **Overview** — dashboard analytics
- **Invoices** — retain the operational invoice list/create flow
- **Reports**
  - Invoice Register
  - Vehicle-wise Invoices
  - Tax
  - Payments Received
  - Receivables
  - Settlement Discounts
- **Customers** — add Statement from customer detail/actions
- **Audit activity** — `CORE_ADMIN` only

Do not duplicate the operational invoice editor inside Reports. Report invoice
numbers should link to the existing invoice detail page.

## Shared API envelope

All paginated JSON report endpoints return:

```ts
interface ReportEnvelope<Row, Summary> {
  data: Row[];
  summary: Summary; // complete filtered result, not only this page
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
  meta: {
    currency: 'INR';
    dateBasis: 'INVOICE_DATE' | 'RECEIPT_DATE' | 'ADJUSTMENT_DATE' | 'EVENT_TIMESTAMP';
    from: string | null;
    to: string | null;
    balanceBasis: 'CURRENT';
    generatedAt: string;
  };
}
```

Money values are decimal strings such as `"81500.00"`. Preserve them as strings in
API types. Format them for display with `Intl.NumberFormat("en-IN", {
style: "currency", currency: "INR" })` through one shared money formatter. Do not
use floating-point arithmetic to create authoritative totals.

Dates are ISO calendar dates. Timestamps are ISO date-times. Display the report's
date basis near the filters or summary so users understand why invoice totals and
cash-received totals can differ.

If `from` and `to` are omitted, the backend uses the current Indian financial year.
Reflect returned `meta.from` and `meta.to` in the UI. Custom ranges are inclusive.
Prevent `to < from` client-side and display the server's 422 error if it still occurs.

The backend reports current balances only. Never label current receivables as an
arbitrary historical “as of” balance and do not add an `asOfDate` control.

## Shared filter and URL behavior

Persist supported filter, sort and page state in URL search parameters so pages are
bookmarkable and browser back/forward works. Do not include empty parameters.

Common report parameters where supported:

```ts
type CommonReportQuery = {
  from?: string;
  to?: string;
  companyId?: string;
  customerId?: string;
  customerCategory?: 'AGENT' | 'LEISURE' | 'CORPORATE';
  serviceCategoryId?: string;
  vehicleId?: string;
  q?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number; // default 1
  pageSize?: number; // default 25, maximum 100
};
```

Use existing master endpoints for filter pickers:

- `GET /companies`
- `GET /customers`
- `GET /service-categories`
- `GET /vehicles`
- `GET /users` where an actor/creator picker is needed

Respect their pagination. Do not assume the first 100 rows contain every option. Use
the existing searchable/paginated combobox pattern or load bounded pages through the
existing data layer. Cache picker records by ID and avoid N+1 requests per table row.

Changing any material filter or page size resets `page` to 1. Debounce free-text
search. Sorting must send only the endpoint's allow-listed `sortBy` value and
`sortOrder`; do not sort the loaded page locally while presenting it as global sort.

Provide a compact active-filter summary and a clear-all action. On mobile, filters
may use an accessible drawer; on desktop, use an inline or collapsible filter bar.

## CSV export behavior

Each table page has an **Export CSV** button that calls the matching `/export`
endpoint with all active business filters and sorting, excluding `page` and
`pageSize`. The server exports the complete filtered result and supplies a filename.

Use the authenticated API layer to download the response as a Blob. Read the
`Content-Disposition` filename when accessible, create a temporary object URL,
trigger the download, and revoke the URL afterward. Do not parse and recreate the
CSV in the browser.

Show export progress and disable duplicate clicks. Handle:

- `401`: use the existing expired-session flow;
- `403`: show the existing forbidden state;
- `413 REPORT_EXPORT_TOO_LARGE`: show “Narrow the report filters before exporting
  more than 100,000 rows” without discarding current filters;
- other error envelopes: show the existing request-ID-aware error treatment.

## 1. Overview dashboard

Endpoint:

```http
GET /reports/dashboard?from&to&companyId&customerCategory&serviceCategoryId
```

Response:

```ts
interface DashboardResponse {
  data: {
    period: { from?: string; to?: string };
    currency: 'INR';
    balanceBasis: 'CURRENT';
    generatedAt: string;
    cards: {
      issuedInvoiceCount: number;
      invoicedAmount: string;
      taxBilled: string;
      cashReceivedDuringPeriod: string;
      outstandingNow: string;
      settlementDiscountsDuringPeriod: string;
      overdueAmount: string;
      overdueInvoiceCount: number;
      cashCollectionRate: number | null;
      settlementCoverageRate: number | null;
    };
    receivablesAgeing: Array<{
      ageingBucket: 'NOT_DUE' | '1_30' | '31_60' | '61_90' | '90_PLUS' | 'NO_DUE_DATE';
      invoiceCount: number;
      outstandingInvoiceCount: number;
      dueAmount: string;
    }>;
    customerCategoryMix: Array<{
      label: 'AGENT' | 'LEISURE' | 'CORPORATE';
      invoiceCount: number;
      amount: string;
    }>;
    serviceCategoryMix: Array<{
      label: string;
      invoiceCount: number;
      amount: string;
    }>;
    topOutstandingCustomers: Array<{
      customerId: string;
      customerName: string;
      customerCategory: 'AGENT' | 'LEISURE' | 'CORPORATE';
      invoiceCount: number;
      dueAmount: string;
      oldestDueDate: string | null;
    }>;
    paymentMethodMix: Array<{
      method: 'CASH' | 'CHEQUE' | 'DD' | 'CARD' | 'UPI';
      count: number;
      amount: string;
    }>;
    financialTrend: Array<{
      month: string; // YYYY-MM
      invoicedAmount: string;
      receivedAmount: string;
    }>;
    recentActivity: Array<{
      id: string;
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      createdAt: string;
    }>;
    alerts: {
      staleDrafts: number;
      receivablesWithoutDueDate: number;
      incompleteCompanies: number;
      hotelRatesExpiringSoon: number;
      staleOutboxEvents: number;
    };
  };
}
```

### Dashboard layout

Use a compact operational layout, not a marketing dashboard:

1. Filter bar with period preset/custom dates, company, customer category and
   service category.
2. First row: Issued invoices, Invoiced amount, Cash received and Outstanding now.
3. Second row: Tax billed, Settlement discounts, Overdue amount/count, Cash
   collection rate and Settlement coverage rate.
4. Financial trend: an accessible two-series monthly chart for invoiced amount and
   cash received. Explain in the legend/tooltip that the two series use invoice date
   and receipt date respectively. Months absent from the response may be rendered as
   zero within the selected returned period.
5. Receivables-ageing chart/table. Keep `NO_DUE_DATE` separate and use readable labels:
   Not due, 1–30, 31–60, 61–90, 90+ days, No due date.
6. Customer-category and service-category mix. Use small bars or tables if they are
   more legible than pie charts.
7. Top outstanding customers table; customer names link to customer detail or its
   statement.
8. Payment-method mix.
9. Recent activity and configuration alerts.

Rates are percentages. Render `null` as “Not available,” not `0%`. Tooltips must
explain:

- cash collection rate = confirmed cash against the filtered invoice cohort divided
  by that cohort's grand total;
- settlement coverage = confirmed cash plus active commercial discounts divided by
  grand total;
- settlement discounts are not cash.

Alert cards should link only where a corresponding existing screen/filter can be
represented honestly. `staleOutboxEvents` is operational; do not invent a public
outbox-management action.

## 2. Invoice Register

Endpoints:

```http
GET /reports/invoices
GET /reports/invoices/export
```

Additional filters:

```ts
status?: "DRAFT" | "ISSUED" | "CANCELLED";
paymentStatus?: "NOT_APPLICABLE" | "UNPAID" | "PARTIALLY_PAID" | "PAID";
financialYear?: string; // four digits such as 2627
hasVehicle?: boolean;
sortBy?:
  | "invoiceDate" | "invoiceNumber" | "customer" | "customerCategory"
  | "serviceCategory" | "vehicle" | "status" | "subtotal" | "taxTotal"
  | "grandTotal" | "receivedAmount" | "adjustmentAmount" | "dueAmount"
  | "dueDate";
```

Row fields:

```ts
interface InvoiceReportRow {
  invoiceId: string;
  invoiceDate: string;
  financialYear: string | null;
  invoiceNumber: string | null;
  status: 'DRAFT' | 'ISSUED' | 'CANCELLED';
  companyId: string;
  companyName: string;
  customerId: string;
  customerName: string;
  customerCategory: 'AGENT' | 'LEISURE' | 'CORPORATE';
  serviceCategoryId: string;
  serviceCategoryName: string;
  vehicleId: string | null;
  vehicleRegistrationNumber: string | null;
  vehicleName: string | null;
  vehicleType: string | null;
  guestDisplayText: string;
  dueDate: string | null;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  receivedAmount: string;
  adjustmentAmount: string;
  dueAmount: string;
  paymentStatus: 'NOT_APPLICABLE' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  issuedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
}
```

Summary fields: `total`, `draftCount`, `issuedCount`, `cancelledCount`, `subtotal`,
`taxTotal`, `grandTotal`, `receivedAmount`, `adjustmentAmount`, `dueAmount`.

Display summary cards above the table. Make invoice number a detail link; for drafts
without a number, use a compact “Draft” label plus a shortened non-sensitive ID.
Show vehicle as registration plus name when present. Keep cancelled and draft rows
visually distinct; their financial values are visible but excluded from issued
summary totals by the server.

## 3. Vehicle-wise Invoices

Endpoints:

```http
GET /reports/vehicle-invoices
GET /reports/vehicle-invoices/export
```

Additional filters:

```ts
status?: "DRAFT" | "ISSUED" | "CANCELLED"; // backend defaults to ISSUED
includeUnassigned?: boolean;
sortBy?:
  | "registrationNumber" | "vehicleName" | "vehicleType" | "invoiceCount"
  | "grandTotal" | "receivedAmount" | "dueAmount";
```

Row fields:

```ts
interface VehicleInvoiceRow {
  vehicleId: string | null;
  vehicleRegistrationNumber: string | null;
  vehicleName: string | null;
  vehicleType: string | null;
  invoiceCount: number;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  receivedAmount: string;
  adjustmentAmount: string;
  dueAmount: string;
  firstInvoiceDate: string;
  latestInvoiceDate: string;
}
```

Summary fields: `total` (vehicle groups), `invoiceCount`, `subtotal`, `taxTotal`,
`grandTotal`, `receivedAmount`, `adjustmentAmount`, `dueAmount`.

Default sort is grand total descending. Use historical vehicle labels returned by
the report. Do not replace them with a current vehicle-master lookup. If
`includeUnassigned=true`, render a clearly labelled “Unassigned historical invoices”
row for a null vehicle. Vehicle drill-down can link to Invoice Register with the
same period and `vehicleId`; do not fabricate a client-side list from aggregate rows.

## 4. Tax Report

Endpoints:

```http
GET /reports/taxes
GET /reports/taxes/export
```

Additional filters:

```ts
status?: "DRAFT" | "ISSUED" | "CANCELLED"; // defaults to ISSUED
component?: "IGST" | "CGST" | "SGST" | "SERVICE_TAX";
rate?: string;
sortBy?: "component" | "rate" | "serviceCategory" | "taxableBase" | "taxAmount";
```

Detail row fields:

```ts
interface TaxReportRow {
  taxId: string;
  invoiceId: string;
  invoiceDate: string;
  invoiceNumber: string | null;
  companyName: string;
  customerName: string;
  customerCategory: 'AGENT' | 'LEISURE' | 'CORPORATE';
  serviceCategoryName: string;
  lineId: string;
  position: number;
  description: string;
  taxableBase: string;
  taxTreatment: string;
  component: 'IGST' | 'CGST' | 'SGST' | 'SERVICE_TAX';
  rate: string;
  taxAmount: string;
}
```

Summary:

```ts
interface TaxSummary {
  total: number;
  taxableBase: string; // distinct invoice-line base
  taxAmount: string;
  breakdown: Array<{
    component: string;
    rate: string;
    serviceCategoryName: string;
    invoiceCount: number;
    taxedLineCount: number;
    taxAmount: string;
  }>;
}
```

Show summary totals, then a compact breakdown by component/rate/category, then the
paginated line-detail table. Do not sum breakdown taxable bases: a CGST/SGST pair
shares the same underlying line base. The authoritative overall taxable base is
`summary.taxableBase`. Label `SERVICE_TAX` as legacy where appropriate. Do not call
this a GST return or statutory filing.

## 5. Payments Received

Endpoints:

```http
GET /reports/payments-received
GET /reports/payments-received/export
```

Additional filters:

```ts
status?: "PENDING" | "CONFIRMED" | "REVERSED"; // defaults to CONFIRMED
method?: "CASH" | "CHEQUE" | "DD" | "CARD" | "UPI";
sortBy?:
  | "receivedDate" | "receiptNumber" | "amount" | "method" | "status"
  | "invoiceNumber" | "customer" | "createdAt";
```

Row fields:

```ts
interface PaymentReportRow {
  receiptId: string;
  receivedDate: string;
  receiptNumber: string;
  status: 'PENDING' | 'CONFIRMED' | 'REVERSED';
  method: 'CASH' | 'CHEQUE' | 'DD' | 'CARD' | 'UPI';
  amount: string;
  details: {
    reference?: string;
    bankName?: string;
    instrumentDate?: string;
    cardLastFour?: string;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  reversalReason: string | null;
  invoiceId: string;
  invoiceDate: string;
  invoiceNumber: string | null;
  companyId: string;
  companyName: string;
  customerId: string;
  customerName: string;
  customerCategory: 'AGENT' | 'LEISURE' | 'CORPORATE';
  serviceCategoryId: string;
  serviceCategoryName: string;
}
```

Summary fields: `total`, `confirmedCount`, `confirmedAmount`, `pendingCount`,
`pendingAmount`, `reversedCount`, `reversedAmount`.

Provide explicit status tabs or a filter. Because the backend defaults to Confirmed,
send a status deliberately when showing Pending or Reversed. Summary values reflect
the active filters; do not assume a Confirmed-filtered response also contains totals
for excluded statuses. Only confirmed payments are cash received. Reversed amounts
are shown as audit history, not automatically as negative cash.

Render method-specific detail safely: never expose or request full card data. The
API only contains the last four digits.

## 6. Receivables

Endpoints:

```http
GET /reports/receivables
GET /reports/receivables/export
```

Additional filters:

```ts
paymentStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID";
ageingBucket?: "NOT_DUE" | "1_30" | "31_60" | "61_90" | "90_PLUS" | "NO_DUE_DATE";
overdueOnly?: boolean;
dueFrom?: string;
dueTo?: string;
sortBy?:
  | "invoiceDate" | "dueDate" | "daysOverdue" | "invoiceNumber" | "customer"
  | "customerCategory" | "serviceCategory" | "vehicle" | "grandTotal"
  | "receivedAmount" | "adjustmentAmount" | "dueAmount";
```

Rows contain all `InvoiceReportRow` fields for issued invoices plus:

```ts
daysOverdue: number | null;
ageingBucket:
  | "NOT_DUE" | "1_30" | "31_60" | "61_90" | "90_PLUS" | "NO_DUE_DATE";
latestPaymentDate: string | null;
```

Summary fields: `total`, `grandTotal`, `receivedAmount`, `adjustmentAmount`,
`dueAmount`, and:

```ts
ageing: Array<{
  ageingBucket: string;
  invoiceCount: number;
  outstandingInvoiceCount: number;
  dueAmount: string;
}>;
```

Show gross, cash received, settlement discounts and due as separate cards. Use
`outstandingInvoiceCount`, not total bucket row count, when describing unpaid
invoices. Keep “No due date” separate. Payment status and due values are current;
there is no historical-as-of selector.

Invoice numbers link to invoice detail. Customer names link to customer detail or
statement. An ageing card/chart selection should update the server-side
`ageingBucket` filter rather than locally hiding rows.

## 7. Settlement Discounts

Endpoints:

```http
GET /reports/settlement-discounts
GET /reports/settlement-discounts/export
```

Additional filters:

```ts
status?: "ACTIVE" | "REVERSED";
creatorId?: string;
sortBy?:
  | "date" | "amount" | "invoiceNumber" | "customer"
  | "customerCategory" | "creator" | "reversedAt";
```

Row fields:

```ts
interface SettlementDiscountRow {
  adjustmentId: string;
  date: string;
  amount: string;
  reason: string;
  status: 'ACTIVE' | 'REVERSED';
  createdBy: string;
  createdAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
  invoiceId: string;
  invoiceDate: string;
  invoiceNumber: string | null;
  invoiceGrandTotal: string;
  companyName: string;
  customerName: string;
  customerCategory: 'AGENT' | 'LEISURE' | 'CORPORATE';
  serviceCategoryName: string;
  currentDueAmount: string;
}
```

Summary fields: `total`, `activeCount`, `activeAmount`, `reversedCount`,
`reversedAmount`.

Use the exact label **Settlement discount**. Never merge it with cash received,
invoice-line discount, tax correction, refund or credit note. Active and reversed
totals must remain visibly separate. Link invoice number to detail. Resolve creator
display names through a bounded users cache if already available; fall back to a
short actor ID without blocking the table.

## 8. Customer Statement

Open this from customer detail or a row action on the Customers page.

Endpoints:

```http
GET /reports/customers/:id/statement?from&to&companyId&includeSettled
GET /reports/customers/:id/statement/export?from&to&companyId&includeSettled
```

Response:

```ts
interface CustomerStatementResponse {
  data: {
    customer: {
      id: string;
      name: string;
      category: 'AGENT' | 'LEISURE' | 'CORPORATE';
    };
    entries: Array<{
      date: string;
      type: 'INVOICE' | 'RECEIPT' | 'SETTLEMENT_DISCOUNT';
      documentId: string;
      documentNumber: string | null;
      description: string;
      debit: string;
      cashCredit: string;
      discountCredit: string;
    }>;
    summary: {
      debit: string;
      cashCredit: string;
      discountCredit: string;
      closingBalance: string;
    };
    dates: { from?: string; to?: string };
  };
}
```

Render customer identity, selected period, summary cards and a chronological table.
Keep Debit, Cash credit and Discount credit as separate numeric columns. Link invoice
and receipt documents where existing detail routes support them. `includeSettled`
defaults to true on the backend; provide a “Hide settled invoices” control that sends
`includeSettled=false`.

Do not display a historical running-balance column. The current backend intentionally
does not claim historical as-of settlement reconstruction.

## 9. Core Audit Activity

Endpoints:

```http
GET /reports/audit
GET /reports/audit/export
```

This page and navigation item are for `CORE_ADMIN` only. Hide them for
`CORE_DATA_ENTRY` and `CORE_REPORT_VIEWER`, but still handle a server 403 because UI
hiding is not authorization.

Filters:

```ts
from?: string;
to?: string;
actorId?: string;
action?: string;
entityType?: string;
entityId?: string;
sortOrder?: "asc" | "desc";
page?: number;
pageSize?: number;
```

Rows:

```ts
interface AuditRow {
  id: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}
```

Summary is `{ total: number }`. Default order is newest first. Convert known action
and entity constants into readable labels while retaining the raw value in a tooltip
or detail affordance. Resolve actors through a bounded user cache when possible.
Do not imply a field-level diff: the API does not return before/after data.

## Data presentation rules

- Use tabular numerals for all financial values.
- Right-align money, rates and counts; keep names and descriptions left-aligned.
- Use semantic status text plus color, never color alone.
- Use `—` for null display values, not `0` or empty business claims.
- Preserve server snapshot names in report rows. Do not overwrite historical customer,
  category or vehicle labels with current master names.
- Keep settlement discounts visually and semantically separate from cash.
- Clearly label legacy Service Tax.
- Never infer missing due dates, payment dates, invoice dates or vehicle assignments.
- Do not add charts whose values are calculated from only a paginated page.

## Loading, empty and failure states

- Use the existing page-level skeleton for the initial request.
- Preserve the current table while a filter/sort/page transition refetches; show a
  subtle busy state without causing layout shift.
- Cancel or ignore stale requests when URL filters change quickly.
- Empty state must distinguish “No records exist” from “No results match these
  filters.” Offer clear filters only in the latter case.
- Keep filters visible after 422, 413, 403 or server errors.
- Use the existing request-ID-aware error component.
- Do not retry authorization or validation failures automatically.
- A report summary and table must update from the same response to avoid mismatched
  filter generations.

## Responsive and accessible behavior

- Use semantic tables with real headers on desktop.
- For narrow screens, use deliberate horizontal scrolling or compact record cards;
  never hide important amount columns without an explicit details affordance.
- All filters, comboboxes, date controls, sort buttons, pagination and export actions
  must be keyboard-operable with visible focus.
- Chart information must also be available in text/table form or accessible labels.
- Announce completed loading, empty results, export start/failure and filter errors
  through appropriate live regions.
- Maintain sufficient contrast and non-color status cues.

## Data fetching and component structure

Keep implementation consistent with the current frontend. A reasonable separation is:

- typed Core report API functions;
- URL query codecs per report;
- shared report filter bar primitives;
- shared summary-card and paginated-table primitives;
- shared CSV download helper;
- report-specific columns and filter definitions;
- dashboard-specific chart/table components.

Do not create one giant report component with conditional columns. Do not use `any`.
Validate/parse network responses using the frontend's established boundary pattern.
Keep money as strings until display. Use stable query keys containing every server
filter, sort, page and page-size value.

## Acceptance tests

Add tests at the same layers already used by the frontend. At minimum cover:

1. Default Overview loads real dashboard data and formats INR values.
2. Date/company/category dashboard filters update the URL and query.
3. Invoice Register renders server summary rather than summing its page.
4. Agent/Leisure/Corporate and service-category filters are sent exactly.
5. Table sorting sends an allow-listed `sortBy` and `sortOrder` and resets page.
6. Vehicle-wise report renders snapshot registration/name and handles unassigned rows.
7. Tax report renders the overall distinct-line taxable base and grouped tax amounts
   without summing component bases together.
8. Payments default to Confirmed and can explicitly request Pending or Reversed.
9. Receivables ageing selection sends `ageingBucket`; no historical as-of UI exists.
10. Settlement discounts never appear as cash received.
11. Customer Statement keeps cash and discount credit columns separate.
12. CSV export forwards active filters, excludes pagination, handles Blob download,
    uses the server filename and shows the 413 message.
13. `CORE_REPORT_VIEWER` and `CORE_DATA_ENTRY` cannot see Audit navigation and a 403
    response still renders safely.
14. Empty, loading, 401, 403, 413, 422 and generic server-error states preserve page
    structure and active filters.
15. Mobile and keyboard interactions cover filters, tables, pagination and export.

## Completion criteria

The task is complete only when all nine pages use live API data, every documented
filter/sort/pagination control works, summary values come from the server, CSV export
downloads the complete filtered report, role handling is correct, tests pass, and no
existing invoice/master workflow regresses. Run the frontend's complete formatting,
lint, type-check, test and production-build commands before handoff.
