import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { createDriverBodySchema } from '../src/modules/drivers/driver.schemas.js';

const requiredDriverFields = {
  displayName: 'Test Driver',
  email: 'driver@example.com',
  password: 'test-password-123',
  driverCode: 'DRIVER-001',
  sourceType: 'AGENCY',
} as const;

describe('create driver request schema', () => {
  it('accepts omitted assignment settings and licence details', () => {
    expect(Check(createDriverBodySchema, requiredDriverFields)).toBe(true);
  });

  it('accepts null for empty assignment settings and licence details', () => {
    expect(
      Check(createDriverBodySchema, {
        ...requiredDriverFields,
        assignmentEnabled: null,
        shiftStartTime: null,
        shiftEndTime: null,
        timeZone: null,
        maxDailyDutyMinutes: null,
        license: null,
      }),
    ).toBe(true);
  });
});
