import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  PaymentProvider,
  PaymentAttemptStatus,
  ProviderOrderSnapshot,
} from '../application/payment-provider.js';
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
        code:
          response.status === 404 ? 'PAYMENT_PROVIDER_ORDER_NOT_FOUND' : 'PAYMENT_PROVIDER_ERROR',
        message: 'Payment provider could not complete the request',
        statusCode: 502,
      });
    }
    return response.json();
  }

  private creationKey(orderId: string): string {
    const hex = createHash('sha256').update(`cashfree:create:${orderId}`).digest('hex');
    // Cashfree expects a UUID. The same merchant order always gets the same key.
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  async createOrder(input: Parameters<PaymentProvider['createOrder']>[0]) {
    let body: { payment_session_id?: string; order_id?: string };
    try {
      body = (await this.request('/orders', {
        method: 'POST',
        headers: { 'x-idempotency-key': this.creationKey(input.orderId) },
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

  async inspectOrder(orderId: string): Promise<ProviderOrderSnapshot> {
    const [orderData, paymentData] = await Promise.all([
      this.request(`/orders/${encodeURIComponent(orderId)}`),
      this.request(`/orders/${encodeURIComponent(orderId)}/payments`),
    ]);
    const invalidResponse = () =>
      new AppError({
        code: 'PAYMENT_PROVIDER_RESPONSE_INVALID',
        message: 'Invalid payment provider response',
        statusCode: 502,
      });
    const record = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
      return value as Record<string, unknown>;
    };
    const date = (value: unknown, optional = false): string | null => {
      if (optional && (value === null || value === undefined)) return null;
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalidResponse();
      return value;
    };
    const order = record(orderData);
    if (
      order.order_id !== orderId ||
      typeof order.order_status !== 'string' ||
      !Array.isArray(paymentData)
    )
      throw invalidResponse();
    const orderStatuses = ['ACTIVE', 'PAID', 'EXPIRED', 'TERMINATED', 'TERMINATION_REQUESTED'];
    const attemptStatuses = [
      'NOT_ATTEMPTED',
      'PENDING',
      'SUCCESS',
      'FAILED',
      'USER_DROPPED',
      'CANCELLED',
      'VOID',
    ];
    const ids = new Set<string>();
    const attempts = paymentData.map((value) => {
      const item = record(value);
      if (
        item.order_id !== orderId ||
        !['string', 'number'].includes(typeof item.cf_payment_id) ||
        !String(item.cf_payment_id) ||
        (typeof item.cf_payment_id === 'number' && !Number.isSafeInteger(item.cf_payment_id)) ||
        typeof item.payment_status !== 'string' ||
        typeof item.payment_currency !== 'string' ||
        typeof item.payment_amount !== 'number' ||
        !Number.isFinite(item.payment_amount) ||
        item.payment_amount < 0 ||
        !Number.isSafeInteger(Math.round(item.payment_amount * 100))
      )
        throw invalidResponse();
      const paymentId = String(item.cf_payment_id);
      if (ids.has(paymentId)) throw invalidResponse();
      ids.add(paymentId);
      const amount = decimal(BigInt(Math.round(item.payment_amount * 100)));
      minor(amount);
      const errors = item.error_details ? record(item.error_details) : {};
      return {
        paymentId,
        status: (item.payment_status === 'SUCCESS' && item.is_captured === false
          ? 'PENDING'
          : attemptStatuses.includes(item.payment_status)
            ? item.payment_status
            : 'UNKNOWN') as PaymentAttemptStatus,
        rawStatus: item.payment_status,
        amount,
        currency: item.payment_currency,
        initiatedAt: date(item.payment_time)!,
        completedAt: date(item.payment_completion_time, true),
        failureCode: typeof errors.error_code === 'string' ? errors.error_code.slice(0, 200) : null,
        failureMessage:
          typeof errors.error_description === 'string'
            ? errors.error_description.slice(0, 1000)
            : null,
      };
    });
    return {
      status: (orderStatuses.includes(order.order_status)
        ? order.order_status
        : 'UNKNOWN') as ProviderOrderSnapshot['status'],
      rawStatus: order.order_status,
      expiresAt: date(order.order_expiry_time, true),
      ...(typeof order.payment_session_id === 'string' && order.payment_session_id
        ? { sessionId: order.payment_session_id }
        : {}),
      attempts,
    };
  }

  verifyWebhook(body: Buffer, signature: string, timestamp: string): boolean {
    if (!signature || !/^\d{10,16}$/.test(timestamp)) return false;
    const supplied = Buffer.from(signature, 'base64');
    const expected = createHmac('sha256', this.secret).update(timestamp).update(body).digest();
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}
