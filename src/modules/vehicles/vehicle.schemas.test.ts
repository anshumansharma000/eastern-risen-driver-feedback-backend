import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { createVehicleBodySchema, updateVehicleBodySchema } from './vehicle.schemas.js';

describe('vehicle contract', () => {
  it('requires the shared vehicle type on creation', () => {
    const vehicle = {
      registrationNumber: 'OD 02 AB 1234',
      displayName: 'Airport SUV',
      vehicleType: 'SUV',
    };

    expect(Check(createVehicleBodySchema, vehicle)).toBe(true);
    expect(Check(createVehicleBodySchema, { ...vehicle, vehicleType: '' })).toBe(false);

    const withoutType: Record<string, unknown> = { ...vehicle };
    delete withoutType.vehicleType;
    expect(Check(createVehicleBodySchema, withoutType)).toBe(false);
  });

  it('accepts optional owner fields and explicit nulls', () => {
    expect(
      Check(createVehicleBodySchema, {
        registrationNumber: 'OD 02 AB 1234',
        displayName: 'Airport SUV',
        vehicleType: 'SUV',
        registeredOwner: 'Vehicle Owner',
        address: null,
        contactNumber: '+919876543210',
        accountNumber: '00012345',
        ifscCode: 'TEST0000123',
        bankName: null,
      }),
    ).toBe(true);
    expect(Check(updateVehicleBodySchema, { accountNumber: null, bankName: null })).toBe(true);
    expect(Check(updateVehicleBodySchema, {})).toBe(false);
  });
});
