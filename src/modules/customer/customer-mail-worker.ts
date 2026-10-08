/** One job per tick avoids overlapping sends and keeps low-volume traffic paced. */
export function startCustomerMailWorker(
  deliverOne: () => Promise<{ processed: number; sent: number; failed: number }>,
  logger: { info: (data: object, message: string) => void; error: (message: string) => void },
  intervalMs: number,
): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void>;
  async function tick() {
    try {
      const result = await deliverOne();
      if (result.processed) logger.info(result, 'Customer email queue processed');
      if (result.failed) logger.error('CUSTOMER_MAIL_DELIVERY_FAILED');
    } catch {
      logger.error('CUSTOMER_MAIL_WORKER_FAILED');
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          running = tick();
        }, intervalMs);
        timer.unref();
      }
    }
  }
  running = tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
