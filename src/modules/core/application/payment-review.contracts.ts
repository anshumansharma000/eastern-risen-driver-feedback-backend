import { createHash } from 'node:crypto';
export const reviewReasonCodes = [
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'ADDITIONAL_SUCCESS',
  'ORDER_ALREADY_UNDER_REVIEW',
  'BOOKING_MISSING',
  'BOOKING_INELIGIBLE',
  'INVOICE_MISSING',
  'INVOICE_NOT_ISSUED',
  'OVERPAYMENT',
  'RECEIPT_VALIDATION_FAILED',
  'RECEIPT_IDEMPOTENCY_CONFLICT',
  'RECEIPT_NOT_CONFIRMED',
  'UNKNOWN_LEGACY_REASON',
] as const;
export type ReviewReasonCode = (typeof reviewReasonCodes)[number];
export interface ReviewReason {
  code: ReviewReasonCode;
  details: Record<string, string>;
}
export type ResolutionAction =
  'APPLY_TO_LINKED_INVOICE' | 'LINK_EXISTING_RECEIPT' | 'RECORD_VERIFIED_EXTERNAL_REFUND';
export type ResolutionInput = {
  version: string;
  note: string;
} & (
  | { action: 'APPLY_TO_LINKED_INVOICE' }
  | { action: 'LINK_EXISTING_RECEIPT'; receiptId: string }
  | {
      action: 'RECORD_VERIFIED_EXTERNAL_REFUND';
      refund: {
        providerRefundReference: string;
        amount: string;
        currency: string;
        completedAt: string;
        verification: { kind: 'STAFF_ATTESTATION'; evidenceReference: string; attested: true };
      };
    }
);
export function gatewayReceiptKey(provider: string, paymentId: string): string {
  return `gw_${createHash('sha256').update(`${provider}:${paymentId}`).digest('hex')}`;
}

/** HTTP contracts: timestamps are serialized ISO strings, dates remain YYYY-MM-DD. */
export type AccountingStatus = 'UNAPPLIED' | 'APPLIED' | 'REVIEW_REQUIRED' | 'REFUNDED';
export type GatewayOrderStatus =
  'CREATING' | 'READY' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'REVIEW_REQUIRED' | 'REFUNDED';
export type ReceiptStatus = 'PENDING' | 'CONFIRMED' | 'REVERSED';
export interface ReviewReceipt {
  id: string;
  invoiceId: string;
  number: string;
  status: ReceiptStatus;
  amount: string;
  receivedDate: string;
  method: 'CASH' | 'CHEQUE' | 'DD' | 'CARD' | 'UPI' | 'GATEWAY';
  reversalReason: string | null;
}
export interface PaymentResolution {
  id: string;
  attemptId: string;
  orderId: string;
  action: ResolutionAction;
  actorId: string;
  note: string;
  receiptId: string | null;
  amount: string;
  currency: string;
  provider: string;
  providerRefundReference: string | null;
  refund: Extract<ResolutionInput, { action: 'RECORD_VERIFIED_EXTERNAL_REFUND' }>['refund'] | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
}
export interface PaymentReviewCase {
  needsReview: boolean;
  version: string;
  order: {
    id: string;
    provider: string;
    providerOrderId: string;
    providerStatus: string | null;
    gatewayStatus: GatewayOrderStatus;
    amount: string;
    receiptId: string | null;
    paidAt: string | null;
  };
  booking: { id: string; reference: string; status: string; companyId: string } | null;
  customer: { id: string; name: string } | null;
  invoice: {
    id: string;
    number: string | null;
    status: 'DRAFT' | 'ISSUED' | 'CANCELLED';
    invoiceDate: string;
    grandTotal: string;
    receivedAmount: string;
    adjustmentAmount: string;
    dueAmount: string;
    paymentStatus: 'NOT_APPLICABLE' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  } | null;
  attempts: {
    id: string;
    providerPaymentId: string;
    status:
      | 'NOT_ATTEMPTED'
      | 'PENDING'
      | 'SUCCESS'
      | 'FAILED'
      | 'USER_DROPPED'
      | 'CANCELLED'
      | 'VOID'
      | 'UNKNOWN';
    accountingStatus: AccountingStatus;
    amount: string;
    currency: string;
    initiatedAt: string;
    completedAt: string | null;
    reviewReasons: ReviewReason[];
    receipt: ReviewReceipt | null;
    receiptAccountingState: ReceiptStatus | 'REVERSED_WITHOUT_REFUND' | null;
    resolution: PaymentResolution | null;
    actions: { action: ResolutionAction; allowed: boolean; blockers: string[] }[];
    matchingReceipts: (ReviewReceipt & { evidenceKind: 'BACKEND_GATEWAY_RECEIPT_IDENTITY' })[];
    existingPaymentReceipts: ReviewReceipt[];
  }[];
  history: PaymentResolution[];
  refundVerificationPolicy: 'STAFF_ATTESTATION_ONLY';
}
export interface PaymentReviewEnvelope {
  data: PaymentReviewCase;
}
export interface PaymentResolutionEnvelope {
  data: { resolution: PaymentResolution; review: PaymentReviewCase };
}
