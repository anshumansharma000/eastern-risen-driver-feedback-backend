import { describe, expect, it } from 'vitest';
import { CommercialService } from './commercial.service.js';
import type { CoreDatabase } from '../persistence/database.js';
import type { BillingRepository } from '../persistence/billing.repository.js';

const service = new CommercialService({} as CoreDatabase, {} as BillingRepository, null);
const futureDate = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

describe('commercial payment schedule', () => {
  it('splits an early booking using the configured percentage and keeps every paise', () => {
    const schedule = service.defaultSchedule('1000.01', futureDate(90), {
      initialPercent: 35,
      balanceDaysBefore: 30,
      fullPaymentWithinDays: 20,
    });
    expect(schedule.map((item) => item.amount)).toEqual(['350.00', '650.01']);
    expect(schedule[1]?.dueOn).toBe(futureDate(60));
  });

  it('requires full payment near departure', () => {
    const schedule = service.defaultSchedule('1000.01', futureDate(10));
    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.amount).toBe('1000.01');
  });
});
