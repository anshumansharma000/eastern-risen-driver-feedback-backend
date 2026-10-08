import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CashfreeProvider } from './cashfree.provider.js';

describe('Cashfree webhook authentication', () => {
  const provider = new CashfreeProvider('sandbox', 'app', 'test-secret');
  const body = Buffer.from('{"data":{"order":{"order_id":"er_123"}}}');
  const timestamp = '1780000000';
  const signature = createHmac('sha256', 'test-secret')
    .update(timestamp)
    .update(body)
    .digest('base64');
  it('accepts only a signature over the original timestamp and bytes', () => {
    expect(provider.verifyWebhook(body, signature, timestamp)).toBe(true);
    expect(provider.verifyWebhook(Buffer.from('{}'), signature, timestamp)).toBe(false);
    expect(provider.verifyWebhook(body, signature, '1780000001')).toBe(false);
  });
});

describe('Cashfree server-side order verification', () => {
  afterEach(() => vi.unstubAllGlobals());
  const order = {
    order_id: 'order_1',
    order_status: 'ACTIVE',
    order_expiry_time: '2026-10-08T12:00:00+05:30',
  };
  const attempt = {
    order_id: 'order_1',
    cf_payment_id: '11',
    payment_status: 'PENDING',
    payment_amount: 500,
    payment_currency: 'INR',
    payment_time: '2026-10-07T10:00:00+05:30',
  };
  function mock(orderValue: unknown, payments: unknown) {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.endsWith('/payments') ? payments : orderValue),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  it('returns every attempt, failure details, completion time and order expiry', async () => {
    const fetchMock = mock(order, [
      {
        ...attempt,
        payment_status: 'FAILED',
        error_details: { error_code: 'DECLINED', error_description: 'Bank declined' },
      },
      {
        ...attempt,
        cf_payment_id: '12',
        payment_status: 'SUCCESS',
        payment_completion_time: '2026-10-07T10:01:00+05:30',
      },
    ]);
    const snapshot = await new CashfreeProvider('sandbox', 'app', 'secret').inspectOrder('order_1');
    expect(snapshot).toMatchObject({ status: 'ACTIVE', expiresAt: order.order_expiry_time });
    expect(snapshot.attempts).toMatchObject([
      {
        paymentId: '11',
        status: 'FAILED',
        failureCode: 'DECLINED',
        failureMessage: 'Bank declined',
        amount: '500.00',
      },
      { paymentId: '12', status: 'SUCCESS', completedAt: '2026-10-07T10:01:00+05:30' },
    ]);
    expect(fetchMock.mock.calls.map((call) => call[0] as unknown)).toEqual([
      'https://sandbox.cashfree.com/pg/orders/order_1',
      'https://sandbox.cashfree.com/pg/orders/order_1/payments',
    ]);
  });
  it('preserves unfamiliar statuses as unresolved rather than failed', async () => {
    mock({ ...order, order_status: 'NEW_STATE' }, [{ ...attempt, payment_status: 'PROCESSING' }]);
    const snapshot = await new CashfreeProvider('sandbox', 'app', 'secret').inspectOrder('order_1');
    expect(snapshot.status).toBe('UNKNOWN');
    expect(snapshot.attempts[0]).toMatchObject({ status: 'UNKNOWN', rawStatus: 'PROCESSING' });
  });
  it.each([
    { ...attempt, payment_amount: -1 },
    { ...attempt, payment_time: 'invalid' },
    { ...attempt, order_id: 'another-order' },
    { ...attempt, cf_payment_id: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid provider data before applying any payment: %j', async (invalid) => {
    mock(order, [invalid]);
    await expect(
      new CashfreeProvider('sandbox', 'app', 'secret').inspectOrder('order_1'),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_RESPONSE_INVALID' });
  });
  it('does not translate a network timeout into a failed payment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(
      new CashfreeProvider('sandbox', 'app', 'secret').inspectOrder('order_1'),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
  });
  it('does not apply successful authorizations until money is captured', async () => {
    mock(order, [{ ...attempt, payment_status: 'SUCCESS', is_captured: false }]);
    const result = await new CashfreeProvider('sandbox', 'app', 'secret').inspectOrder('order_1');
    expect(result.attempts[0]).toMatchObject({ status: 'PENDING', rawStatus: 'SUCCESS' });
  });
  it('recovers an uncertain create using the original order ID', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ order_id: 'order_1', payment_session_id: 'session' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await new CashfreeProvider('sandbox', 'app', 'secret').createOrder({
        orderId: 'order_1',
        amount: '500.00',
        customerId: 'customer',
        customerName: 'Payer',
        customerPhone: '9876543210',
      }),
    ).toEqual({ sessionId: 'session' });
    const options = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(options.headers['x-idempotency-key']).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://sandbox.cashfree.com/pg/orders/order_1');
  });
});
