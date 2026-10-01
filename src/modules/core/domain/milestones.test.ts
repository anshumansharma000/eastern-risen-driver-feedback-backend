import { describe, expect, it } from 'vitest';
import { allocateMilestones } from './milestones.js';

const schedule = [
  { position: 1, amount: '30.01', status: 'PENDING', remainingAmount: '30.01' },
  { position: 2, amount: '70.00', status: 'PENDING', remainingAmount: '70.00' },
];

describe('confirmed receipt allocation to milestones', () => {
  it.each([
    ['0.00', ['30.01', '70.00'], ['PENDING', 'PENDING']],
    ['0.01', ['30.00', '70.00'], ['PARTIALLY_PAID', 'PENDING']],
    ['30.01', ['0.00', '70.00'], ['PAID', 'PENDING']],
    ['30.02', ['0.00', '69.99'], ['PAID', 'PARTIALLY_PAID']],
    ['100.01', ['0.00', '0.00'], ['PAID', 'PAID']],
  ])(
    'allocates %s precisely and replaces stale response fields',
    (received, remaining, statuses) => {
      const result = allocateMilestones(schedule, received);
      expect(result.map((item) => item.remainingAmount)).toEqual(remaining);
      expect(result.map((item) => item.status)).toEqual(statuses);
      expect(schedule[0]?.status).toBe('PENDING');
    },
  );

  it('uses position order, caps coverage, and preserves precision for large amounts', () => {
    const result = allocateMilestones(
      [
        { position: 2, amount: '0.01' },
        { position: 1, amount: '999999999999.98' },
      ],
      '999999999999.99',
    );
    expect(result.map((item) => item.remainingAmount)).toEqual(['0.00', '0.00']);
    expect(result.map((item) => item.position)).toEqual([1, 2]);
    expect(allocateMilestones([{ position: 1, amount: '0.01' }], '0.02')[0]?.remainingAmount).toBe(
      '0.00',
    );
  });
});
