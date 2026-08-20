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

describe('booking tour details contract', () => {
  it('allows tour name and file number to be omitted or supplied during creation', () => {
    expect(Check(createBookingBodySchema, validBooking)).toBe(true);
    expect(
      Check(createBookingBodySchema, {
        ...validBooking,
        tourName: 'Rajasthan Heritage Tour',
        fileNumber: 'FILE-2048',
      }),
    ).toBe(true);
    expect(
      Check(createBookingBodySchema, { ...validBooking, tourName: null, fileNumber: null }),
    ).toBe(true);
  });

  it('allows tour name and file number to be changed or cleared during update', () => {
    expect(Check(updateBookingBodySchema, { tourName: 'Golden Triangle' })).toBe(true);
    expect(Check(updateBookingBodySchema, { fileNumber: 'FIT-1001' })).toBe(true);
    expect(Check(updateBookingBodySchema, { tourName: null, fileNumber: null })).toBe(true);
  });

  it('enforces field length limits', () => {
    expect(Check(createBookingBodySchema, { ...validBooking, tourName: 'T'.repeat(201) })).toBe(
      false,
    );
    expect(Check(updateBookingBodySchema, { fileNumber: 'F'.repeat(101) })).toBe(false);
  });
});
