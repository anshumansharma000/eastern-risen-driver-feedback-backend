import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { createAdminTripBodySchema, updateAdminTripBodySchema } from './trip.schemas.js';

const trip = {
  bookingId: '00000000-0000-4000-8000-000000000001',
  pickupLocation: 'Airport',
  destination: 'Hotel',
  scheduledAt: '2029-01-01T08:00:00.000Z',
  scheduledEndAt: '2029-01-01T10:00:00.000Z',
  vehicleId: '00000000-0000-4000-8000-000000000002',
  driverId: '00000000-0000-4000-8000-000000000003',
};

describe('trip engagement contract', () => {
  it('accepts trip scheduling without feedback configuration', () => {
    expect(Check(createAdminTripBodySchema, trip)).toBe(true);
  });

  it('rejects manual feedback section assignment', () => {
    expect(
      Check(createAdminTripBodySchema, {
        ...trip,
        feedbackPurposes: ['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK'],
      }),
    ).toBe(false);
    expect(Check(updateAdminTripBodySchema, { feedbackPurposes: [] })).toBe(false);
  });
});
