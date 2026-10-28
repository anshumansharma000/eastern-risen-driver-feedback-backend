import { describe, expect, it } from 'vitest';
import { createFieldEncryptor } from './field-encryption.js';

describe('field encryption', () => {
  it('creates stable keyed indexes isolated by domain, value and encryption key', () => {
    const encryptor = createFieldEncryptor(Buffer.alloc(32, 5));
    const first = encryptor.blindIndex('respondent', 'engagement:+919876543210');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(encryptor.blindIndex('respondent', 'engagement:+919876543210')).toBe(first);
    expect(encryptor.blindIndex('another-domain', 'engagement:+919876543210')).not.toBe(first);
    expect(encryptor.blindIndex('respondent', 'other-engagement:+919876543210')).not.toBe(first);
    expect(
      createFieldEncryptor(Buffer.alloc(32, 6)).blindIndex(
        'respondent',
        'engagement:+919876543210',
      ),
    ).not.toBe(first);
  });
  it('uses randomized authenticated encryption without exposing plaintext', () => {
    const encryptor = createFieldEncryptor(Buffer.alloc(32, 5));
    const first = encryptor.encrypt('passenger@example.com');
    const second = encryptor.encrypt('passenger@example.com');

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first).not.toContain('passenger@example.com');
    expect(second).not.toBe(first);
    expect(encryptor.decrypt(first)).toBe('passenger@example.com');
  });
});
