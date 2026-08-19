import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { createBookingBodySchema, updateBookingBodySchema } from './booking.schemas.js';

const validBooking = {
  bookingReference: 'BOOK-1001',
  passengerName: 'Passenger Name',
  passengerPhone: '+919876543210',
  startsAt: '2029-01-01T08:00:00.000Z',
  endsAt: '2029-01-01T10:00:00.000Z',
};

describe('booking phone contract', () => {
  it('requires an E.164 passenger phone when creating a booking', () => {
    expect(Check(createBookingBodySchema, validBooking)).toBe(true);
    expect(Check(createBookingBodySchema, { ...validBooking, passengerPhone: '9876543210' })).toBe(
      false,
    );

    const withoutPhone: Record<string, unknown> = { ...validBooking };
    delete withoutPhone.passengerPhone;
    expect(Check(createBookingBodySchema, withoutPhone)).toBe(false);
  });

  it('allows an E.164 passenger phone to be added during booking update', () => {
    expect(Check(updateBookingBodySchema, { passengerPhone: '+447911123456' })).toBe(true);
    expect(Check(updateBookingBodySchema, { passengerPhone: '+44 7911 123456' })).toBe(false);
    expect(Check(updateBookingBodySchema, { passengerPhone: null })).toBe(false);
  });
});
