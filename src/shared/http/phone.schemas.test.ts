import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { updateDriverBodySchema } from '../../modules/drivers/driver.schemas.js';
import { submitFeedbackBodySchema } from '../../modules/feedback/feedback.schemas.js';
import { updateDriverProfileBodySchema } from '../../modules/profiles/profile.schemas.js';
import { updateVendorBodySchema } from '../../modules/vendors/vendor.schemas.js';
import { e164PhoneSchema } from './phone.schemas.js';

const canonicalPhone = '+919876543210';
const formattedPhone = '+91-98765-43210';

describe('E.164 phone contract', () => {
  it('accepts only a plus-prefixed country code and digits', () => {
    expect(Check(e164PhoneSchema, canonicalPhone)).toBe(true);
    expect(Check(e164PhoneSchema, '+447911123456')).toBe(true);
    expect(Check(e164PhoneSchema, formattedPhone)).toBe(false);
    expect(Check(e164PhoneSchema, '9876543210')).toBe(false);
    expect(Check(e164PhoneSchema, '+0123456789')).toBe(false);
  });

  it('applies the contract to driver, profile, and vendor updates', () => {
    expect(Check(updateDriverBodySchema, { phone: canonicalPhone })).toBe(true);
    expect(Check(updateDriverProfileBodySchema, { phone: canonicalPhone })).toBe(true);
    expect(Check(updateVendorBodySchema, { contactPhone: canonicalPhone })).toBe(true);

    expect(Check(updateDriverBodySchema, { phone: formattedPhone })).toBe(false);
    expect(Check(updateDriverProfileBodySchema, { phone: formattedPhone })).toBe(false);
    expect(Check(updateVendorBodySchema, { contactPhone: formattedPhone })).toBe(false);
  });

  it('applies the contract to new passenger feedback submissions', () => {
    const submission = {
      clientSubmissionId: '00000000-0000-4000-8000-000000000001',
      questionnaireVersionId: '00000000-0000-4000-8000-000000000002',
      questionnaireSnapshot: {},
      respondent: {
        name: 'Passenger',
        phone: canonicalPhone,
        email: 'passenger@example.com',
        bookingReference: 'BOOK-1',
        consentAccepted: true,
        consentedAt: '2026-08-18T10:00:00.000Z',
      },
      answers: [],
      submittedAt: '2026-08-18T10:00:00.000Z',
      submissionMode: 'ONLINE',
    };

    expect(Check(submitFeedbackBodySchema, submission)).toBe(true);
    expect(
      Check(submitFeedbackBodySchema, {
        ...submission,
        respondent: { ...submission.respondent, phone: formattedPhone },
      }),
    ).toBe(false);
  });
});
