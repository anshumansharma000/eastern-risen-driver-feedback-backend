export type PaymentAttemptStatus =
  | 'NOT_ATTEMPTED'
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'USER_DROPPED'
  | 'CANCELLED'
  | 'VOID'
  | 'UNKNOWN';

export interface ProviderPaymentAttempt {
  paymentId: string;
  status: PaymentAttemptStatus;
  rawStatus: string;
  amount: string;
  currency: string;
  initiatedAt: string;
  completedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface ProviderOrderSnapshot {
  status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED' | 'UNKNOWN';
  rawStatus: string;
  expiresAt: string | null;
  sessionId?: string;
  attempts: ProviderPaymentAttempt[];
}

export interface PaymentProvider {
  readonly name: string;
  createOrder(input: {
    orderId: string;
    amount: string;
    customerId: string;
    customerName: string;
    customerPhone: string;
    customerEmail?: string;
  }): Promise<{ sessionId: string }>;
  /** Query the gateway directly; callbacks and browser results are not proof of money received. */
  inspectOrder(orderId: string): Promise<ProviderOrderSnapshot>;
  verifyWebhook(body: Buffer, signature: string, timestamp: string): boolean;
}
