import { describe, expect, it } from 'vitest';
import { createFieldEncryptor } from './field-encryption.js';

describe('field encryption', () => {
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
