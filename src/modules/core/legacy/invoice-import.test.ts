import { describe, expect, it } from 'vitest';
import { validateLegacyInvoice } from './invoice-import.js';
const id = '00000000-0000-4000-8000-000000000001';
const baseLine = {
  description: 'Legacy service',
  amount: '100.00',
  taxTreatment: 'TAXABLE',
  taxComponents: ['SERVICE_TAX'],
};
const record = {
  source: 'legacy',
  sourceTable: 'invoices',
  sourceId: '13930',
  rawRecord: { InvoiceNo: 13930 },
  invoiceNumber: '13930',
  invoice: {
    companyId: id,
    customerId: id,
    serviceCategoryId: id,
    invoiceDate: '2016-08-20',
    guestDisplayText: 'Traveller X 04',
    serviceProvidedAt: 'ODISHA',
    placeOfSupplyState: 'ODISHA',
    placeOfSupplyCountry: 'INDIA',
    bankAccountIds: [],
    lines: [baseLine],
  },
  snapshot: {
    company: { name: 'Original company' },
    customer: { name: 'Original agent' },
    serviceCategory: { code: '9985' },
    bankAccounts: [],
  },
  lines: [
    {
      position: 1,
      description: baseLine.description,
      amount: '100.00',
      taxTreatment: 'TAXABLE',
      taxes: [{ component: 'SERVICE_TAX', rate: '5', amount: '4.99' }],
      taxAmount: '4.99',
      total: '104.99',
    },
  ],
  subtotal: '100.00',
  taxTotal: '4.99',
  grandTotal: '104.99',
};
describe('legacy invoice normalization', () => {
  it('preserves recorded tax instead of recomputing historical rounding', () =>
    expect(validateLegacyInvoice(record).taxTotal).toBe('4.99'));
  it('rejects unreconciled totals without rewriting them', () =>
    expect(() => validateLegacyInvoice({ ...record, grandTotal: '105.00' })).toThrow(
      'do not reconcile',
    ));
  it('rejects inconsistent displayed and persisted service lines', () =>
    expect(() =>
      validateLegacyInvoice({
        ...record,
        invoice: { ...record.invoice, lines: [{ ...baseLine, description: 'Different' }] },
      }),
    ).toThrow('must agree'));
  it('rejects invalid structure and unknown fields', () =>
    expect(() => validateLegacyInvoice({ ...record, unexpected: 'field' })).toThrow(
      'interchange schema',
    ));
});
