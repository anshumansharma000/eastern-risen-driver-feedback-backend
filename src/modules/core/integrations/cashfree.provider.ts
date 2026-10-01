import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentProvider } from '../application/payment-provider.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { decimal, minor } from '../domain/money.js';

export class CashfreeProvider implements PaymentProvider {
  readonly name = 'cashfree';
  private readonly baseUrl: string;
  constructor(
    environment: 'sandbox' | 'production',
    private readonly appId: string,
    private readonly secret: string,
    private readonly webhookUrl: string | null = null,
  ) {
    this.baseUrl =
      environment === 'production'
        ? 'https://api.cashfree.com/pg'
        : 'https://sandbox.cashfree.com/pg';
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(10000),
        headers: {
          'Content-Type': 'application/json',
          'x-api-version': '2025-01-01',
          'x-client-id': this.appId,
          'x-client-secret': this.secret,
          ...init?.headers,
        },
      });
    } catch {
      throw new AppError({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'Payment provider is unavailable',
        statusCode: 503,
      });
    }
    if (!response.ok) {
      throw new AppError({
        code: 'PAYMENT_PROVIDER_ERROR',
        message: 'Payment provider could not complete the request',
        statusCode: 502,
      });
    }
    return response.json();
  }

  async createOrder(input: Parameters<PaymentProvider['createOrder']>[0]) {
    let body: { payment_session_id?: string; order_id?: string };
    try {
      body = (await this.request('/orders', {
        method: 'POST',
        headers: { 'x-idempotency-key': input.orderId },
        body: JSON.stringify({
          order_id: input.orderId,
          order_amount: Number(input.amount),
          order_currency: 'INR',
          ...(this.webhookUrl ? { order_meta: { notify_url: this.webhookUrl } } : {}),
          customer_details: {
            customer_id: input.customerId,
            customer_name: input.customerName,
            customer_phone: input.customerPhone,
            ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
          },
        }),
      })) as typeof body;
    } catch {
      // A timed-out create may have succeeded remotely. Reuse the same order ID.
      body = (await this.request(`/orders/${encodeURIComponent(input.orderId)}`)) as typeof body;
    }
    if (body.order_id !== input.orderId || !body.payment_session_id) {
      throw new AppError({
        code: 'PAYMENT_PROVIDER_RESPONSE_INVALID',
        message: 'Invalid payment provider response',
        statusCode: 502,
      });
    }
    return { sessionId: body.payment_session_id };
  }

  async successfulPayment(orderId: string) {
    const payments = (await this.request(
      `/orders/${encodeURIComponent(orderId)}/payments`,
    )) as Array<{
      cf_payment_id: string | number;
      payment_status: string;
      payment_amount: number;
      payment_currency: string;
      payment_time: string;
    }>;
    if (!Array.isArray(payments))
      throw new AppError({
        code: 'PAYMENT_PROVIDER_RESPONSE_INVALID',
        message: 'Invalid payment provider response',
        statusCode: 502,
      });
    const paid = payments.find((item) => item.payment_status === 'SUCCESS');
    if (!paid) return null;
    if (
      paid.payment_currency !== 'INR' ||
      !Number.isFinite(paid.payment_amount) ||
      !paid.payment_time
    ) {
      throw new AppError({
        code: 'PAYMENT_PROVIDER_RESPONSE_INVALID',
        message: 'Invalid payment provider response',
        statusCode: 502,
      });
    }
    const amount = decimal(BigInt(Math.round(paid.payment_amount * 100)));
    minor(amount);
    return {
      paymentId: String(paid.cf_payment_id),
      amount,
      currency: 'INR' as const,
      receivedAt: paid.payment_time,
    };
  }

  verifyWebhook(body: Buffer, signature: string, timestamp: string): boolean {
    if (!signature || !/^\d{10,16}$/.test(timestamp)) return false;
    const supplied = Buffer.from(signature, 'base64');
    const expected = createHmac('sha256', this.secret).update(timestamp).update(body).digest();
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}
