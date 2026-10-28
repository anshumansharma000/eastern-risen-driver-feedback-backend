import { describe, expect, it } from 'vitest';
import { normalizeRespondentPhone } from './respondent-phone.js';

describe('feedback respondent phone normalization', () => {
  it.each(['+919876543210', '+91 (98765) 43210', '0091 98765-43210', ' +91.98765.43210 '])(
    'canonicalizes %s',
    (phone) => {
      expect(normalizeRespondentPhone(phone)).toBe('+919876543210');
    },
  );
  it.each(['9876543210', '+0123456789', '+123', '+1234567890123456', 'abc', '+919876543210 ext 3'])(
    'rejects %s',
    (phone) => {
      expect(() => normalizeRespondentPhone(phone)).toThrow('Enter a valid phone number');
    },
  );
});
