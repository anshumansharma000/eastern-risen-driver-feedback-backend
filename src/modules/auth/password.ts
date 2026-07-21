import argon2 from 'argon2';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$MKLE/jGMhLkhVnp+YGu/bg$UmD5Xgue9zkSiDsRawUNxTNqY0erzBGE/xF1VTbM5Qw';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  performDummyVerification(password: string): Promise<void>;
}

export const passwordHasher: PasswordHasher = {
  async hash(password) {
    const result = (await argon2.hash(password, ARGON2_OPTIONS)) as unknown;
    if (typeof result !== 'string') throw new Error('Argon2 returned an invalid encoded hash');
    return result;
  },
  async verify(hash, password) {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  },
  async performDummyVerification(password) {
    await argon2.verify(DUMMY_PASSWORD_HASH, password);
  },
};
