import type { ReceiptInput } from '../application/billing.contracts.js';
import { invalid } from './errors.js';
import { minor } from './money.js';
import { validateDate } from './validation.js';
export function validateReceipt(input: ReceiptInput): void {
  validateDate(input.receivedDate);
  if (minor(input.amount) === 0n) throw invalid('Receipt amount must be greater than zero');
  const { method, details } = input;
  if (method !== 'CASH' && !details.reference?.trim())
    throw invalid('A payment reference is required');
  if (method === 'CHEQUE' || method === 'DD') {
    if (!details.bankName?.trim() || !details.instrumentDate)
      throw invalid('Bank name and instrument date are required');
    validateDate(details.instrumentDate);
  }
  if (method === 'CARD' && !/^\d{4}$/.test(details.cardLastFour ?? ''))
    throw invalid('Only the last four card digits are required');
  const allowed =
    method === 'CASH'
      ? []
      : method === 'CARD'
        ? ['reference', 'cardLastFour']
        : method === 'UPI'
          ? ['reference']
          : ['reference', 'bankName', 'instrumentDate'];
  if (Object.keys(details).some((key) => !allowed.includes(key)))
    throw invalid('Payment details do not match the selected method');
}
