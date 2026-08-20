import { describe, expect, it } from 'vitest';
import { findPostgresError, isPostgresError } from './postgres-error.js';

describe('PostgreSQL error detection', () => {
  it('finds errors wrapped by the database query layer', () => {
    const wrapped = new Error('Query failed', {
      cause: Object.assign(new Error('Unique violation'), {
        code: '23505',
        constraint: 'example_unique',
      }),
    });

    expect(isPostgresError(wrapped, '23505')).toBe(true);
    expect(findPostgresError(wrapped, '23505')?.constraint).toBe('example_unique');
  });
});
