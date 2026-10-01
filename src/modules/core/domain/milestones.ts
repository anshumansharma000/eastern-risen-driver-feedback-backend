import { decimal, minor } from './money.js';

export type MilestonePaymentStatus = 'PENDING' | 'PARTIALLY_PAID' | 'PAID';

/** Confirmed invoice receipts cover milestones in position order, regardless of order origin.
 * Discounts reduce invoice debt, but are not collected cash and do not pay milestones.
 * Deriving allocations avoids stale state after manual confirmation or reversal.
 */
export function allocateMilestones<T extends { position: number; amount: string }>(
  milestones: readonly T[],
  receivedAmount: string,
) {
  let available = minor(receivedAmount);
  return [...milestones]
    .sort((a, b) => a.position - b.position)
    .map((milestone) => {
      const amount = minor(milestone.amount);
      const allocated = available < amount ? available : amount;
      available -= allocated;
      const remaining = amount - allocated;
      const status: MilestonePaymentStatus =
        remaining === 0n ? 'PAID' : allocated === 0n ? 'PENDING' : 'PARTIALLY_PAID';
      return {
        ...milestone,
        remainingAmount: decimal(remaining),
        status,
      };
    });
}
