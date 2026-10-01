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

  it('ignores failed attempts and returns only a successful INR payment', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          cf_payment_id: '11',
          payment_status: 'FAILED',
          payment_amount: 500,
          payment_currency: 'INR',
          payment_time: '2026-09-28T10:00:00+05:30',
        },
        {
          cf_payment_id: '12',
          payment_status: 'SUCCESS',
          payment_amount: 500,
          payment_currency: 'INR',
          payment_time: '2026-09-28T10:01:00+05:30',
        },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new CashfreeProvider('sandbox', 'app', 'secret');
    expect(await provider.successfulPayment('order_1')).toEqual({
      paymentId: '12',
      amount: '500.00',
      currency: 'INR',
      receivedAt: '2026-09-28T10:01:00+05:30',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://sandbox.cashfree.com/pg/orders/order_1/payments',
    );
  });
});
