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
  /** The provider is queried directly; webhook content is never trusted as proof of payment. */
  successfulPayment(orderId: string): Promise<{
    paymentId: string;
    amount: string;
    currency: 'INR';
    receivedAt: string;
  } | null>;
  verifyWebhook(body: Buffer, signature: string, timestamp: string): boolean;
}
