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

describe('trip feedback section contract', () => {
  it('allows defaults to be requested by omitting purposes', () => {
    expect(Check(createAdminTripBodySchema, trip)).toBe(true);
  });

  it('accepts explicit section selections and replacement with an empty array', () => {
    expect(
      Check(createAdminTripBodySchema, {
        ...trip,
        feedbackPurposes: ['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK'],
      }),
    ).toBe(true);
    expect(Check(updateAdminTripBodySchema, { feedbackPurposes: [] })).toBe(true);
  });

  it('rejects duplicate and unknown purposes', () => {
    expect(
      Check(createAdminTripBodySchema, {
        ...trip,
        feedbackPurposes: ['DRIVER_FEEDBACK', 'DRIVER_FEEDBACK'],
      }),
    ).toBe(false);
    expect(Check(updateAdminTripBodySchema, { feedbackPurposes: ['UNKNOWN'] })).toBe(false);
  });
});
