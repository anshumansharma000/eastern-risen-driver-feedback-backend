import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCustomerMailWorker } from './customer-mail-worker.js';

afterEach(() => vi.useRealTimers());
describe('customer mail worker', () => {
  it('does not overlap batches and waits for the active send before stopping', async () => {
    vi.useFakeTimers();
    let complete!: (result: { processed: number; sent: number; failed: number }) => void;
    const deliver = vi.fn(
      () =>
        new Promise<{ processed: number; sent: number; failed: number }>((resolve) => {
          complete = resolve;
        }),
    );
    const logger = { info: vi.fn(), error: vi.fn() };
    const stop = startCustomerMailWorker(deliver, logger, 10000);
    await vi.advanceTimersByTimeAsync(30000);
    expect(deliver).toHaveBeenCalledTimes(1);
    let stopped = false;
    const done = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    complete({ processed: 1, sent: 1, failed: 0 });
    await done;
    await vi.advanceTimersByTimeAsync(30000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('recovers after database failures without logging sensitive errors', async () => {
    vi.useFakeTimers();
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error('secret-db-url'))
      .mockResolvedValue({ processed: 1, sent: 0, failed: 1 });
    const logger = { info: vi.fn(), error: vi.fn() };
    const stop = startCustomerMailWorker(deliver, logger, 10000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls).toEqual([
      ['CUSTOMER_MAIL_WORKER_FAILED'],
      ['CUSTOMER_MAIL_DELIVERY_FAILED'],
    ]);
    await stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
