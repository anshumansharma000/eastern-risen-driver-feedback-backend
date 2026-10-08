import type { PlanMilestone } from '../application/commercial.contracts.js';
import { invalid } from './errors.js';
import { minor, sum } from './money.js';
import { validateDate } from './validation.js';
/** Presentation requires current/future dates. Activation preserves accepted dates, including overdue ones. */
export function validateProposedMilestones(
  milestones: PlanMilestone[],
  total: string,
  today: string,
) {
  if (!milestones.length || milestones.length > 12) throw invalid('A plan needs 1–12 milestones');
  for (const milestone of milestones) {
    validateDate(milestone.dueOn);
    if (!milestone.label.trim() || minor(milestone.amount) <= 0n || milestone.dueOn < today)
      throw invalid('Proposed milestones need labels, positive amounts and dates today or later');
  }
  if (minor(sum(milestones.map((m) => m.amount))) !== minor(total))
    throw invalid('Payment plan amounts must exactly equal the quote total');
}
