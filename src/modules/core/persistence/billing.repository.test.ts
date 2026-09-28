import { describe, expect, it } from 'vitest';
import type { InvoiceSnapshot } from '../application/billing.contracts.js';
import { normalizeInvoiceSnapshot } from './billing.repository.js';

describe('invoice snapshot response compatibility', () => {
  it('normalizes snapshots stored before guest, bank name and embedded IDs were required', () => {
    const snapshot = {
      company: { name: 'Historic Company' },
      customer: { name: 'Historic Customer' },
      serviceCategory: { name: 'Transport', code: '9966' },
      bankAccounts: [
        {
          name: 'Operations account',
          accountNumber: '00001234',
          branch: 'Kolkata',
          ifscCode: 'TEST0000123',
        },
      ],
    } as unknown as InvoiceSnapshot;

    expect(
      normalizeInvoiceSnapshot({
        companyId: 'company-id',
        customerId: 'customer-id',
        guestId: 'guest-id',
        serviceCategoryId: 'category-id',
        vehicleId: null,
        details: {
          companyId: 'company-id',
          customerId: 'customer-id',
          guestId: 'guest-id',
          guestDisplayText: 'Traveller group',
          serviceCategoryId: 'category-id',
          invoiceDate: '2026-09-09',
          serviceProvidedAt: 'Kolkata',
          placeOfSupplyState: 'West Bengal',
          placeOfSupplyCountry: 'INDIA',
          bankAccountIds: ['bank-id'],
          lines: [],
        },
        snapshot,
      }),
    ).toMatchObject({
      company: { id: 'company-id', name: 'Historic Company' },
      customer: { id: 'customer-id', name: 'Historic Customer' },
      guest: { id: 'guest-id', name: 'Traveller group' },
      serviceCategory: { id: 'category-id', name: 'Transport', code: '9966' },
      vehicle: null,
      bankAccounts: [
        {
          id: 'bank-id',
          name: 'Operations account',
          bankName: null,
          accountNumber: '00001234',
          branch: 'Kolkata',
          ifscCode: 'TEST0000123',
        },
      ],
    });
  });
});
