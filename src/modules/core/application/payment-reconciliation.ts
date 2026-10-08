import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { CoreDatabase, CoreTransaction } from '../persistence/database.js';
import { paymentOrders, paymentReconciliationJobs } from '../persistence/commercial.schema.js';
import type { CommercialService } from './commercial.service.js';
import { AppError } from '../../../shared/errors/app-error.js';

export async function enqueuePaymentReconciliation(tx: CoreTransaction, orderId: string) {
  await tx
    .insert(paymentReconciliationJobs)
    .values({ orderId, nextCheckAt: sql`now()` })
    .onConflictDoUpdate({
      target: paymentReconciliationJobs.orderId,
      set: {
        nextCheckAt: sql`now()`,
        revision: sql`${paymentReconciliationJobs.revision} + 1`,
        updatedAt: new Date(),
      },
    });
}

/** Initial polls are frequent; old unresolved attempts remain scheduled and visible. */
export function reconciliationDelay(createdAt: Date, now = new Date()): number {
  const age = now.getTime() - createdAt.getTime();
  if (age < 5 * 60000) return 60000;
  if (age < 30 * 60000) return 5 * 60000;
  if (age < 2 * 3600000) return 15 * 60000;
  if (age < 24 * 3600000) return 3600000;
  return 24 * 3600000;
}

export async function processPaymentReconciliation(
  db: CoreDatabase,
  commercial: CommercialService,
  closedRecheckDays = 7,
) {
  const job = await db.transaction(async (tx) => {
    const [due] = await tx
      .select()
      .from(paymentReconciliationJobs)
      .where(
        and(
          lte(paymentReconciliationJobs.nextCheckAt, sql`now()`),
          or(
            isNull(paymentReconciliationJobs.leaseUntil),
            lte(paymentReconciliationJobs.leaseUntil, sql`now()`),
          ),
        ),
      )
      .orderBy(asc(paymentReconciliationJobs.nextCheckAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!due) return null;
    const token = randomUUID();
    await tx
      .update(paymentReconciliationJobs)
      .set({
        leaseToken: token,
        leaseUntil: sql`now() + interval '2 minutes'`,
        updatedAt: new Date(),
      })
      .where(eq(paymentReconciliationJobs.orderId, due.orderId));
    return { ...due, token };
  });
  if (!job) return { processed: 0, failed: 0 };
  let nextCheckAt: Date | null = null;
  let failureCount = 0;
  let errorCode: string | null = null;
  try {
    const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, job.orderId));
    if (!order) throw new Error('Missing payment order');
    const result = await commercial.reconcile(order.providerOrderId, false);
    // Recheck closed orders for late bank outcomes for seven days. Pending and
    // unknown attempts never silently expire from the reconciliation queue.
    const unresolved =
      result.hasUnresolvedAttempts ||
      result.orderStatus === 'READY' ||
      result.orderStatus === 'CREATING';
    const recentlyClosed = Date.now() - order.createdAt.getTime() < closedRecheckDays * 86400000;
    if (unresolved || recentlyClosed) {
      nextCheckAt = new Date(
        Date.now() + (unresolved ? reconciliationDelay(order.createdAt) : 86400000),
      );
    }
  } catch (error) {
    failureCount = job.failureCount + 1;
    errorCode = error instanceof AppError ? error.code : 'PAYMENT_RECONCILIATION_FAILED';
    if (failureCount >= 10) {
      await db
        .update(paymentOrders)
        .set({ reviewRequiredAt: sql`coalesce(${paymentOrders.reviewRequiredAt}, now())` })
        .where(eq(paymentOrders.id, job.orderId));
    }
    nextCheckAt = new Date(
      Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(failureCount - 1, 6)),
    );
  }
  // A webhook arriving during this run increments revision. Keep its immediate
  // follow-up instead of overwriting it with this worker's backoff.
  await db
    .update(paymentReconciliationJobs)
    .set({
      nextCheckAt: sql`CASE WHEN ${paymentReconciliationJobs.revision} = ${job.revision} THEN ${nextCheckAt?.toISOString() ?? null}::timestamptz ELSE now() END`,
      leaseToken: null,
      leaseUntil: null,
      failureCount,
      lastErrorCode: errorCode,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentReconciliationJobs.orderId, job.orderId),
        eq(paymentReconciliationJobs.leaseToken, job.token),
      ),
    );
  return { processed: 1, failed: errorCode ? 1 : 0 };
}

export function startPaymentReconciliationWorker(
  processOne: () => Promise<{ processed: number; failed: number }>,
  logger: { info: (data: object, message: string) => void; error: (message: string) => void },
  intervalMs: number,
): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void>;
  async function tick() {
    try {
      const result = await processOne();
      if (result.processed) logger.info(result, 'Payment reconciliation queue processed');
      if (result.failed) logger.error('PAYMENT_RECONCILIATION_FAILED');
    } catch {
      logger.error('PAYMENT_RECONCILIATION_WORKER_FAILED');
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
