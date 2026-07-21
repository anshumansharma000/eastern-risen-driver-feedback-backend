import { describe, expect, it } from 'vitest';
import { passwordHasher } from './password.js';

describe('passwordHasher', () => {
  it('hashes with Argon2id and verifies the matching password', async () => {
    const encoded = await passwordHasher.hash('a-long-test-password');

    expect(encoded).toContain('$argon2id$');
    await expect(passwordHasher.verify(encoded, 'a-long-test-password')).resolves.toBe(true);
    await expect(passwordHasher.verify(encoded, 'incorrect-password')).resolves.toBe(false);
  });
});
