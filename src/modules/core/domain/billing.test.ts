import { describe, expect, it } from 'vitest';
import { calculateLines, invoiceTotals, outstanding, type LineInput } from './billing.js';
import { decimal, minor, taxAmount } from './money.js';
import { financialYear, validateDate } from './validation.js';
import { validateReceipt } from './payment.js';
const line: LineInput = {
  description: '4 passengers / itinerary / hotel and vehicle',
  amount: '81500.00',
  taxTreatment: 'TAXABLE',
  taxComponents: ['IGST'],
};
const rate = { id: 'rate-1', component: 'IGST' as const, rate: '5.0000', serviceCategoryId: null };
describe('core billing arithmetic and rules', () => {
  it('reproduces the supplied invoice totals', () =>
    expect(invoiceTotals(calculateLines([line], [rate], 'itinerary'))).toEqual({
      subtotal: '81500.00',
      taxTotal: '4075.00',
      grandTotal: '85575.00',
    }));
  it('rounds per line and component using half-up, with no floating point error', () => {
    expect(taxAmount('0.10', '5')).toBe('0.01');
    expect(taxAmount('0.09', '5')).toBe('0.00');
    expect(taxAmount('999999999999.99', '5.125')).toBe('51250000000.00');
    expect(decimal(minor('0.10') + minor('0.20'))).toBe('0.30');
  });
  it('rejects malformed money, excess precision and overflow', () => {
    for (const input of ['1', '1.001', '-1.00', '1e3', 'NaN', '01.00'])
      expect(() => minor(input)).toThrow();
    expect(() => decimal(100000000000000n)).toThrow();
  });
  it('chooses a service-specific rate before an all-services rate', () => {
    const [result] = calculateLines(
      [line],
      [rate, { ...rate, id: 'specific', serviceCategoryId: 'itinerary', rate: '12' }],
      'itinerary',
    );
    expect(result!.taxes[0]!.ruleId).toBe('specific');
  });
  it('rejects ambiguous and missing applicable rates', () => {
    expect(() => calculateLines([line], [rate, { ...rate, id: 'duplicate' }], 'itinerary')).toThrow(
      'found 2',
    );
    expect(() => calculateLines([line], [], 'itinerary')).toThrow('found 0');
  });
  it('supports mixed taxable and non-taxable rows', () =>
    expect(
      invoiceTotals(
        calculateLines(
          [line, { ...line, amount: '100.00', taxTreatment: 'NON_TAXABLE', taxComponents: [] }],
          [rate],
          'itinerary',
        ),
      ).grandTotal,
    ).toBe('85675.00'));
  it('rejects invalid tax combinations and newly charged legacy service tax', () => {
    for (const taxComponents of [
      ['IGST', 'CGST', 'SGST'],
      ['CGST'],
      ['SGST'],
      ['IGST', 'IGST'],
      ['SERVICE_TAX'],
    ] as LineInput['taxComponents'][])
      expect(() => calculateLines([{ ...line, taxComponents }], [rate], 'itinerary')).toThrow();
    expect(() =>
      calculateLines([{ ...line, taxTreatment: 'EXEMPT' }], [rate], 'itinerary'),
    ).toThrow();
  });
  it('tracks received cash separately from settlement discount', () => {
    expect(outstanding('1000.00', '950.00', '50.00')).toBe('0.00');
    expect(() => outstanding('1000.00', '951.00', '50.00')).toThrow();
  });
  it('uses April financial-year boundaries and rejects invalid dates', () => {
    expect(financialYear('2026-03-31')).toBe('2526');
    expect(financialYear('2026-04-01')).toBe('2627');
    expect(() => validateDate('2026-02-30')).toThrow();
  });
  it('requires method-specific receipt details and rejects card secrets', () => {
    const base = {
      invoiceId: 'invoice',
      receivedDate: '2026-08-20',
      amount: '10.00',
      status: 'CONFIRMED' as const,
    };
    expect(() => validateReceipt({ ...base, method: 'UPI', details: {} })).toThrow();
    expect(() =>
      validateReceipt({ ...base, method: 'CHEQUE', details: { reference: '123' } }),
    ).toThrow();
    expect(() =>
      validateReceipt({
        ...base,
        method: 'CARD',
        details: { reference: 'txn', cardLastFour: '1234567890123456' },
      }),
    ).toThrow();
    expect(() =>
      validateReceipt({ ...base, method: 'CASH', details: { reference: 'unneeded' } }),
    ).toThrow();
    expect(() =>
      validateReceipt({ ...base, method: 'UPI', details: { reference: 'txn' } }),
    ).not.toThrow();
  });
});
