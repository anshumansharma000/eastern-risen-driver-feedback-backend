# Frontend implementation prompt: print invoice reports

Implement a browser-print option for the existing **Invoice Register** and
**Vehicle-wise Invoices** report screens. The backend repository already owns CSV
generation; its `/reports/invoices/export` and `/reports/vehicle-invoices/export`
responses now omit database IDs/internal lifecycle fields and provide human-readable
CSV headings. Continue downloading those responses as Blobs without rebuilding CSV
in the browser.

Add a **Print** button next to **Export CSV** on both report screens. Printing is a
frontend concern: use a dedicated print view and `window.print()`; do not introduce
or imply a server-generated PDF endpoint.

Requirements:

- Carry the active business filters and server sort order into the print view.
- Clearly show the report title, selected date range, active filter summary,
  generation timestamp, and currency (`INR`).
- Use human-readable column labels. Never print raw IDs, database/API field names,
  internal timestamps, hidden metadata, or shortened IDs used for draft-row links.
- Invoice Register columns: Invoice Date, Financial Year, Invoice Number, Invoice
  Status, Company, Customer, Customer Category, Service Category, Vehicle
  Registration Number, Vehicle Name, Vehicle Type, Guest, Due Date, Subtotal, Tax
  Total, Grand Total, Received Amount, Settlement Discount, Due Amount, Payment
  Status, and Cancellation Reason.
- Vehicle-wise columns: Vehicle Registration Number, Vehicle Name, Vehicle Type,
  Invoice Count, Subtotal, Tax Total, Grand Total, Received Amount, Settlement
  Discount, Due Amount, First Invoice Date, and Latest Invoice Date.
- Use server-provided full-filter `summary` values for totals; never calculate totals
  from only the visible page.
- Make the printed scope explicit. If the implementation prints only the currently
  loaded page, label it **Current page**. Do not silently fetch an unbounded result
  set. If the existing data layer already supports safe bounded full-report loading,
  show progress and enforce the backend's 100,000-row export ceiling.
- Add `@media print` styles that hide application navigation, filters, pagination,
  buttons, links, and other interactive chrome; use a white background, black text,
  compact spacing, legible numeric alignment, and sensible column widths.
- Repeat table headers on each printed page (`thead { display: table-header-group; }`),
  avoid splitting individual rows where practical, and allow long customer/guest/
  cancellation text to wrap without clipping.
- Use landscape orientation for these wide reports, keep totals together where
  possible, and ensure missing values render as an em dash rather than `null` or
  `undefined`.
- Preserve accessibility: the Print button needs an accessible name, keyboard
  operation, visible focus, and a busy/disabled state while preparing the print view.
- Restore the normal screen cleanly after printing or cancelling.

Tests should cover button visibility by authorization, propagation of current
filters/sort, omission of IDs/internal fields, readable labels and totals, current-
page scope labelling when applicable, print-only CSS behavior, and cleanup after the
`afterprint` event. Manually verify Chrome/Edge print preview at A4 landscape with
zero rows, one row, long text, and enough rows to span multiple pages.
