import type { CalculatedLine, LineInput } from '../domain/billing.js';
import type { InvoiceInput } from './billing.contracts.js';
export interface QuotePricing {
  lines: CalculatedLine[];
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  taxEffectiveDate: string;
  currency: 'INR';
  rounding: 'HALF_UP_PER_LINE_COMPONENT';
}
export interface PlanMilestone {
  label: string;
  amount: string;
  dueOn: string;
}
export interface PlanInput {
  mode: 'COMPANY_DEFAULT' | 'CUSTOM';
  milestones?: PlanMilestone[];
}
export interface ProposedPlan {
  mode: 'COMPANY_DEFAULT' | 'CUSTOM';
  milestones: PlanMilestone[];
  resolvedOn: string;
  policy: {
    initialPercent: number;
    balanceDaysBefore: number;
    fullPaymentWithinDays: number;
  } | null;
  overdueRule: 'KEEP_ACCEPTED_DATES';
}
export interface StructuredQuoteInput {
  lines: LineInput[];
  taxEffectiveDate: string;
  paymentPlan: PlanInput;
}
export type InvoiceReviewDetails = Omit<
  InvoiceInput,
  'companyId' | 'customerId' | 'serviceCategoryId' | 'lines'
>;
