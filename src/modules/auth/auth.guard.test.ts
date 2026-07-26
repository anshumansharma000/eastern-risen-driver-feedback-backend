import { describe, expect, it } from 'vitest';
import { sessionCookieClearOptions, sessionCookieOptions } from './auth.guard.js';

describe('session cookie options', () => {
  it('allows secure production cookies on cross-site API requests', () => {
    expect(sessionCookieOptions(true, new Date(Date.now() + 60_000))).toMatchObject({
      httpOnly: true,
      sameSite: 'none',
      secure: true,
    });
    expect(sessionCookieClearOptions(true)).toMatchObject({
      httpOnly: true,
      sameSite: 'none',
      secure: true,
    });
  });

  it('keeps non-secure local development cookies same-site', () => {
    expect(sessionCookieOptions(false, new Date(Date.now() + 60_000))).toMatchObject({
      sameSite: 'lax',
      secure: false,
    });
    expect(sessionCookieClearOptions(false)).toMatchObject({
      sameSite: 'lax',
      secure: false,
    });
  });
});
