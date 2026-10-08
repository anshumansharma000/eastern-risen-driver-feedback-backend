import { describe, expect, it } from 'vitest';
import { validateProposedMilestones } from './proposed-plan.js';
describe('proposed milestone validation', () => {
  it('keeps exact paise allocations', () => {
    expect(() =>
      validateProposedMilestones(
        [
          { label: 'Initial', amount: '30.00', dueOn: '2026-10-07' },
          { label: 'Balance', amount: '70.01', dueOn: '2026-10-08' },
        ],
        '100.01',
        '2026-10-07',
      ),
    ).not.toThrow();
  });
  it.each(
    [
      [{ label: 'Zero', amount: '0.00', dueOn: '2026-10-07' }],
      [{ label: 'Bad date', amount: '100.01', dueOn: '2026-02-30' }],
      [{ label: 'Past', amount: '100.01', dueOn: '2026-10-06' }],
      [{ label: 'Wrong total', amount: '100.00', dueOn: '2026-10-07' }],
      [],
      Array.from({ length: 13 }, () => ({ label: 'Many', amount: '1.00', dueOn: '2026-10-07' })),
    ].map((milestones) => [milestones]),
  )('rejects invalid plan %j', (milestones) => {
    expect(() => validateProposedMilestones(milestones, '100.01', '2026-10-07')).toThrow();
  });
});
