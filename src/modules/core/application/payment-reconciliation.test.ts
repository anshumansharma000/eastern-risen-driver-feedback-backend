import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconciliationDelay, startPaymentReconciliationWorker } from './payment-reconciliation.js';

describe('payment reconciliation worker', () => {
  afterEach(() => vi.useRealTimers());
  it('paces polling while retaining daily checks for old unresolved payments', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    expect(reconciliationDelay(now, now)).toBe(60000);
    expect(reconciliationDelay(new Date(now.getTime() - 10 * 60000), now)).toBe(5 * 60000);
    expect(reconciliationDelay(new Date(now.getTime() - 40 * 60000), now)).toBe(15 * 60000);
    expect(reconciliationDelay(new Date(now.getTime() - 4 * 3600000), now)).toBe(3600000);
    expect(reconciliationDelay(new Date('2026-01-01'), now)).toBe(86400000);
  });
  it('does not overlap batches and waits for in-flight work during shutdown', async () => {
    vi.useFakeTimers();
    let finish!: (result: { processed: number; failed: number }) => void;
    const process = vi.fn(
      () =>
        new Promise<{ processed: number; failed: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const stop = startPaymentReconciliationWorker(process, { info: vi.fn(), error: vi.fn() }, 1000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(process).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish({ processed: 1, failed: 0 });
    await stopping;
    await vi.advanceTimersByTimeAsync(10000);
    expect(process).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('recovers from database errors without logging secrets', async () => {
    vi.useFakeTimers();
    const process = vi
      .fn()
      .mockRejectedValueOnce(new Error('private database connection'))
      .mockResolvedValue({ processed: 1, failed: 1 });
    const logger = { info: vi.fn(), error: vi.fn() };
    const stop = startPaymentReconciliationWorker(process, logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(process).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls).toEqual([
      ['PAYMENT_RECONCILIATION_WORKER_FAILED'],
      ['PAYMENT_RECONCILIATION_FAILED'],
    ]);
    await stop();
  });
});
