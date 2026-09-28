# Core Admin reports and basic analytics specification

## 1. Scope and reporting principles

This specification covers only the Eastern Risen Core Admin module: companies,
customers, guests, service categories, vehicles, invoices, applied taxes, receipts,
commercial settlement discounts and Core audit activity. Driver-feedback analytics
are outside scope.

All displayed money is INR and uses decimal strings with two fractional digits in
the API. The frontend may format values with the Indian numbering system, but must
never recalculate authoritative totals from paginated rows.

Reports use preserved invoice snapshots for issued-document labels. Current master
records are used only as filter identities and picker data. This prevents a later
customer, category or vehicle rename from changing historical report output.

Cancelled invoices are visible when requested but are excluded from financial
totals by default. Drafts may be included in the invoice register but never count as
invoiced revenue, tax billed, receivables or settlement totals.

### 1.1 Date bases

Every report must label its date basis:

| Metric/report               | Authoritative date      |
| --------------------------- | ----------------------- |
| Invoices and invoiced value | `invoiceDate`           |
| Tax billed                  | invoice `invoiceDate`   |
| Cash received               | receipt `receivedDate`  |
| Settlement discounts        | adjustment `date`       |
| Current receivables         | balance at request time |
| Audit activity              | event `createdAt`       |

The default reporting period is the current financial year. Custom `from` and `to`
dates are inclusive and must satisfy `from <= to`. Historical imported invoices use
their invoice date; their synthetic issue timestamp must not be used for reporting.

### 1.2 Common filters and response behavior

Where relevant, reports support:

- `from` and `to` inclusive ISO dates;
- `companyId`;
- `customerId`;
- customer `category`: `AGENT`, `LEISURE` or `CORPORATE`;
- `serviceCategoryId`;
- `vehicleId`;
- invoice `status`: `DRAFT`, `ISSUED` or `CANCELLED`;
- `q` for invoice number, customer name, guest display text or vehicle registration;
- allow-listed `sortBy` and `sortOrder=asc|desc`;
- `page` and `pageSize`, with a maximum page size of 100.

Paginated report responses contain:

```json
{
  "data": [],
  "summary": {},
  "pagination": { "page": 1, "pageSize": 25, "total": 0 },
  "meta": {
    "currency": "INR",
    "dateBasis": "INVOICE_DATE",
    "from": "2026-04-01",
    "to": "2027-03-31",
    "balanceBasis": "CURRENT",
    "generatedAt": "2026-09-11T00:00:00.000Z"
  }
}
```

`summary` is calculated over the complete filtered result, never only the current
page. Invalid sort fields, contradictory filters and invalid date ranges return 422.
Empty reports return an empty `data` array and zero-valued summaries.

All tabular reports provide CSV export using the same filters and sort order. Export
must stream or process in bounded batches and must not silently truncate at the UI
page-size limit. CSV contains machine-friendly ISO dates and unformatted decimal
amounts. Spreadsheet formula prefixes in text cells must be escaped. Invoice-register
and vehicle-invoice exports use an explicit report-facing column allow-list: database
identifiers and internal lifecycle timestamps are omitted, and headings use readable
labels rather than API/database field notation.

Core Admin, Core Data Entry and Core Report Viewer can read financial reports. The
audit report is Core Admin-only because it exposes staff activity. Mutation
permissions do not change.

## 2. Core dashboard analytics

Suggested endpoint: `GET /api/v1/core/reports/dashboard`.

### 2.1 Dashboard filters

- Period: current financial year by default, predefined current month/quarter/year,
  previous financial year, or custom `from`/`to`.
- Optional company, customer category and service-category filters.
- Current balance and ageing widgets use today's date and current settlement states.

Vehicle and individual customer filters belong on detailed reports rather than the
main dashboard.

### 2.2 Headline cards

1. **Issued invoices** — count of invoices currently in `ISSUED` status whose
   `invoiceDate` is in the selected period.
2. **Invoiced amount** — sum of `grandTotal` for that issued-invoice cohort. Label it
   “Invoiced amount,” not accounting revenue.
3. **Tax billed** — sum of persisted applied-tax amounts for the same cohort.
4. **Cash received during period** — sum of receipts currently in `CONFIRMED` status
   whose `receivedDate` is in the selected period, regardless of the source invoice's
   date. Reversed and pending receipts contribute zero.
5. **Outstanding now** — issued invoice total minus currently confirmed receipts and
   currently active settlement discounts.
6. **Settlement discounts during period** — active adjustment amounts whose
   adjustment date is in the selected period. Reversed adjustments contribute zero.
7. **Overdue amount** — current outstanding balance of issued invoices with a
   non-null `dueDate` before today.
8. **Overdue invoices** — count of those invoices with positive outstanding balance.

Each card includes a tooltip stating its date basis and exclusions. Period-over-period
percentage comparison is shown only when both periods are complete and comparable;
otherwise return/display `null`, not an invented zero percent.

### 2.3 Settlement ratios

For issued invoices in the selected invoice-date cohort, calculated using current
settlement states:

- `cashCollectionRate = confirmedReceiptAmount / grandTotal * 100`;
- `settlementCoverageRate = (confirmedReceiptAmount + activeAdjustmentAmount) /
grandTotal * 100`.

These are separate because a commercial discount is not cash. If the cohort total is
zero, the rate is `null`.

### 2.4 Dashboard charts and tables

1. **Invoiced versus cash received trend** — monthly issued `grandTotal` by invoice
   date and confirmed receipt amount by receipt date. Two clearly labelled series;
   no implication that a month's receipts settle that same month's invoices.
2. **Current receivables ageing** — Not due, 1–30, 31–60, 61–90 and 90+ days overdue, plus a
   separate “No due date” bucket. Show invoice count and outstanding amount.
3. **Customer-category mix** — issued invoice count and grand total for Agent,
   Leisure and Corporate customers. Use the issued customer snapshot category.
4. **Service-category mix** — issued invoice count and grand total by snapshotted
   service category, sorted by amount descending.
5. **Top outstanding customers** — top ten by current outstanding balance,
   including oldest unpaid due date and overdue amount.
6. **Payment-method mix** — confirmed cash received during the period by Cash,
   Cheque, DD, Card and UPI.
7. **Recent activity** — the ten most recent issued invoices, confirmed/reversed
   receipts, settlement discounts/reversals and cancellations. This is operational
   context, not a financial total.

### 2.5 Configuration alerts

The dashboard includes counts linking to actionable lists:

- draft invoices older than 30 days;
- issued invoices with no due date and positive balance;
- companies missing address, state or country and therefore unable to issue drafts;
- vehicle-required service categories when no active vehicle exists;
- hotel rates expiring in the next 30 days;
- unpublished Core outbox events older than a configured operational threshold.

No alert should label optional GST/PAN/contact fields as errors without an approved
business rule.

## 3. Report: Invoice register

Suggested endpoint: `GET /api/v1/core/reports/invoices`.

Purpose: the canonical searchable register of draft, issued and cancelled invoices.

### Filters

- Invoice-date range;
- company, customer and customer category;
- service category and vehicle;
- invoice and payment status;
- financial year;
- free-text `q`;
- optional `hasVehicle=true|false`.

### Columns

- invoice date, financial year and invoice number;
- status;
- company;
- customer name and customer category;
- guest display text;
- service category;
- vehicle registration/name when present;
- subtotal, tax total and grand total;
- confirmed amount received;
- active settlement discount;
- current due amount and payment status;
- due date;
- issued and cancelled timestamps;
- cancellation reason when cancelled.

### Summary

- row count by status;
- subtotal, tax and grand total for issued invoices;
- confirmed receipts allocated to the displayed issued-invoice cohort;
- active discounts and current due for that cohort.

### Sorting

Invoice date, invoice number, customer, customer category, service category, vehicle
registration, status, subtotal, tax total, grand total, received amount, discount,
due amount and due date. Default: invoice date descending, then invoice ID for stable
pagination.

Cancelled and draft monetary rows remain visible when selected but are kept separate
from issued totals.

## 4. Report: Vehicle-wise invoices

Suggested endpoint: `GET /api/v1/core/reports/vehicle-invoices`.

Purpose: show the number and value of Car Service invoices attributable to each
vehicle and allow drill-down to the underlying invoices.

### Filters

- Invoice-date range;
- company, customer and customer category;
- vehicle;
- service category, restricted by default to categories whose snapshot/configuration
  has `requiresVehicle=true`;
- invoice status, default `ISSUED`;
- vehicle status as a current-master filter only;
- vehicle registration/name search.

### Grouped columns

- snapshotted vehicle ID, registration number, display name and vehicle type;
- issued invoice count;
- subtotal, tax and grand total;
- confirmed receipts;
- active settlement discounts;
- current outstanding amount;
- first and latest invoice dates.

### Drill-down columns

Invoice date/number, company, customer/category, guest display text, service category,
subtotal, tax, total, received, discount, due and payment status.

### Summary and sorting

The report header shows total vehicles, invoices, subtotal, tax, grand total,
received, discount and due across the full filter. Sort groups by registration,
vehicle name/type, invoice count, grand total, received or due. Default: grand total
descending.

Historical labels come from `snapshot.vehicle`; the current vehicle master must not
rewrite them. Older invoices without a vehicle appear only when an explicit
“Unassigned historical invoices” option is enabled.

## 5. Report: Tax summary and detail

Suggested endpoint: `GET /api/v1/core/reports/taxes`.

Purpose: reconcile the exact persisted taxes applied to issued invoices. This is an
operational tax report, not a GST return or statutory filing engine.

### Filters

- Invoice-date range;
- company;
- customer and customer category;
- service category;
- tax component: IGST, CGST, SGST or legacy Service Tax;
- exact applied rate;
- invoice number search;
- status, default `ISSUED`.

### Summary groups

Group by component, applied rate and optionally service category. Each row contains:

- component and rate;
- service category when grouped;
- distinct invoice count;
- taxable line count;
- taxable base represented by those lines;
- tax amount.

CGST and SGST legitimately repeat the same taxable base in their separate component
rows. Therefore taxable bases must not be summed across component rows to produce a
grand taxable value. The report returns a separate distinct-line taxable-base total.

### Detail columns

Invoice date/number, company, customer/category, service category, line position and
description, line amount, tax treatment, component, persisted rate and persisted tax
amount.

### Sorting

Invoice date, invoice number, customer, category, component, rate, taxable base and
tax amount. Default summary sort: component then rate; default detail sort: invoice
date then invoice number then line position.

## 6. Report: Payments received

Suggested endpoint: `GET /api/v1/core/reports/payments-received`.

Purpose: cash-collection and bank-reconciliation view based on receipt dates.

### Filters

- Receipt-date range;
- company;
- invoice/customer/customer category;
- service category;
- payment method;
- receipt status: Pending, Confirmed or Reversed; default Confirmed;
- receipt number or payment-reference search.

### Columns

- receipt date and receipt number;
- status;
- method;
- amount;
- payment reference, bank name, instrument date or masked card suffix where relevant;
- invoice date and number;
- company;
- customer/category;
- service category;
- creator and creation timestamp;
- reversal reason and update timestamp for reversed receipts.

### Summary

- confirmed receipt count and amount;
- pending receipt count and amount;
- reversed receipt count and amount shown separately;
- confirmed amount by method.

Only confirmed receipts contribute to “Total payment received.” A reversed receipt is
an audit fact, not negative cash in this report unless a future accounting export
defines reversal posting semantics.

### Sorting

Receipt date/number, amount, method, status, invoice number, customer and creation
time. Default: receipt date descending, then receipt ID.

## 7. Report: Payment due and receivables ageing

Suggested endpoint: extend `GET /api/v1/core/reports/receivables`.

Purpose: collection worklist and current accounts-receivable view.

### Calculation

For each currently issued invoice:

```text
receivedAmount   = receipts whose current status is CONFIRMED
discountAmount   = settlement discounts that are not currently reversed
dueAmount        = grandTotal - receivedAmount - discountAmount
```

Draft and cancelled invoices have no receivable. Ageing is evaluated against today's
date. Historical point-in-time balances are not part of the initial contract.

### Filters

- Invoice-date range;
- company, customer and customer category;
- service category and vehicle;
- payment status: Unpaid, Partially Paid or Paid;
- ageing bucket;
- due-date range;
- `overdueOnly`;
- invoice/customer search.

### Columns

- invoice date/number;
- due date and days overdue;
- ageing bucket;
- company;
- customer/category;
- guest display text;
- service category and vehicle when present;
- grand total;
- confirmed received amount;
- active settlement discount;
- due amount;
- payment status;
- latest confirmed payment date.

Invoices with positive due and no due date use a distinct “No due date” bucket; they
must not be silently treated as current or overdue.

### Summary and sorting

Summary contains invoice count, gross amount, received, discount, due and totals per
ageing bucket. Sort by invoice/due date, days overdue, invoice number, customer,
category, service category, vehicle, total, received, discount or due. Default:
oldest due date first, no-due-date rows last, then invoice ID.

## 8. Report: Settlement discounts

Suggested endpoint: `GET /api/v1/core/reports/settlement-discounts`.

Purpose: report explicitly authorized commercial settlement adjustments without
misrepresenting them as cash, invoice-line discounts or tax corrections.

### Filters

- Adjustment-date range;
- company, invoice, customer and customer category;
- service category;
- active/reversed status;
- creator;
- reason search.

### Columns

- adjustment date;
- active or reversed status;
- amount and reason;
- invoice date/number and grand total;
- company;
- customer/category;
- service category;
- creator and creation time;
- reversal time and reversal reason;
- current invoice due amount.

### Summary and sorting

Show active discount count/amount and reversed count/amount separately. Only active
adjustments contribute to “Total discount given.” Sort by adjustment date, amount,
invoice number, customer, category, creator or reversal date. Default: adjustment
date descending, then adjustment ID.

Legacy receipt discounts must not be included until their meaning is reviewed and
their import is explicitly reconciled. If the legacy value was a pre-tax invoice
discount rather than a settlement adjustment, it requires a different data model and
reporting treatment.

## 9. Report: Customer statement

Suggested endpoint: `GET /api/v1/core/reports/customers/:id/statement`.

Purpose: provide a chronological, invoice-linked statement for collection follow-up.

### Filters

- Required customer ID;
- period;
- optional company;
- include/exclude fully settled invoices;
- current balances only.

### Statement entries

- issued invoice: debit equal to `grandTotal`;
- confirmed receipt: credit equal to receipt amount;
- active settlement discount: separately labelled non-cash credit;
- receipt or discount reversal: separately labelled reversal event;
- cancelled invoice: informational only because active settlements must already have
  been reversed and it has no receivable.

The statement returns period invoice debits, currently confirmed cash credits,
currently active settlement-discount credits and current closing balance. Cash and
discount columns remain separate. Entries include document date/number, type,
description, debit, cash credit and discount credit. A historical running balance is
not displayed until settlement transition history can support it accurately.

This is not a general ledger: advance/unallocated payments, credit notes and opening
balances outside imported invoice-linked transactions are not currently modeled.

## 10. Report: Core audit activity

Suggested endpoint: `GET /api/v1/core/reports/audit`, Core Admin-only.

Purpose: trace who performed important Core actions and when.

### Filters

- Event timestamp range;
- actor;
- action;
- entity type and entity ID.

### Columns

- event timestamp;
- actor ID and current display name when resolvable;
- action;
- entity type and ID;
- safe link to the relevant Core detail page when available.

Sort by event time, actor, action or entity type. Default: newest first. The current
audit schema does not contain before/after values or arbitrary metadata, so the UI
must not imply a field-level diff. Adding such data is a separate audited design
decision that must avoid credentials, bank secrets and unnecessary personal data.

## 11. Existing guest activity view

`GET /api/v1/core/guests/:id/activity` remains a contextual guest-detail widget, not
a global report. It shows the latest issued service and latest confirmed payment,
plus separately labelled legacy last-service/last-amount fields. Those legacy fields
must never be counted as invoices or payments.

## 12. Delivery sequence

### Release 1: legacy parity and operational essentials

1. Shared reporting query/filter/sort/pagination contract and CSV export foundation.
2. Invoice register.
3. Vehicle-wise invoices.
4. Tax summary/detail.
5. Payments received.
6. Enhanced payment-due/receivables ageing.
7. Settlement-discount report.

### Release 2: basic analytics and administration

1. Dashboard headline cards and monthly trend.
2. Ageing, customer-category and service-category breakdowns.
3. Top outstanding customers and payment-method mix.
4. Customer statement.
5. Core audit activity and configuration alerts.

## 13. Reconciliation gate

Before calling the reports production-complete, reconcile legacy data by count and
amount for invoices, tax, confirmed payments, outstanding balances and discounts.
The current importer does not import historical receipts or discounts. Until those
settlements are imported and verified, payment received, receivables, collection
rates, customer statements and discount totals are complete only for native/new Core
transactions. The UI must show a data-readiness notice rather than presenting partial
historical settlement totals as complete.

## 14. Deferred historical as-of reporting

The current receipt record keeps current status but does not preserve a complete,
queryable timeline for initially confirmed, later confirmed and later reversed
states. Therefore the initial reports must not accept an arbitrary historical
`asOfDate` or claim historical running balances. Supporting that later requires
explicit receipt confirmation/reversal timestamps or an immutable settlement-status
history, followed by reconciliation tests. Settlement discounts already preserve a
reversal timestamp, but the weaker receipt history controls the accuracy of the
combined receivable.
