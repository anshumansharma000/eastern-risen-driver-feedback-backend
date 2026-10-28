import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export interface FieldEncryptor {
  encrypt(plaintext: string): string;
  decrypt(envelope: string): string;
  blindIndex(domain: string, value: string): string;
}

export function createFieldEncryptor(key: Buffer): FieldEncryptor {
  if (key.length !== 32) throw new Error('Field-encryption key must contain 32 bytes');
  const indexKey = createHmac('sha256', key).update('field-blind-index-v1').digest();
  return {
    blindIndex(domain, value) {
      return createHmac('sha256', indexKey)
        .update(JSON.stringify([domain, value]))
        .digest('hex');
    },
    encrypt(plaintext) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
    },
    decrypt(envelope) {
      const [version, nonceValue, ciphertextValue, tagValue] = envelope.split('.');
      if (version !== 'v1' || !nonceValue || ciphertextValue === undefined || !tagValue) {
        throw new Error('Encrypted field has an invalid envelope');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceValue, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
