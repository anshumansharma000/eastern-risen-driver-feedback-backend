import { describe, expect, it } from 'vitest';
import { resolveDatabaseConnection } from './database-connection.js';

describe('resolveDatabaseConnection', () => {
  it('uses unencrypted local connections by default', () => {
    const connection = resolveDatabaseConnection('postgresql://user:pass@localhost:5432/app', {});

    expect(connection.sslMode).toBe('disable');
    expect(connection.ssl).toBe(false);
  });

  it('translates a DigitalOcean sslmode=require URL into explicit TLS settings', () => {
    const connection = resolveDatabaseConnection(
      'postgresql://user:pass@db.example.com:25060/app?sslmode=require',
      {},
    );

    expect(connection.sslMode).toBe('require');
    expect(connection.ssl).toEqual({ rejectUnauthorized: false });
    expect(connection.url).not.toContain('sslmode');
  });

  it('supports verify-full using a base64-encoded managed database CA', () => {
    const certificate = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';
    const connection = resolveDatabaseConnection('postgresql://user:pass@db.example.com/app', {
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_CA_CERT_BASE64: Buffer.from(certificate).toString('base64'),
    });

    expect(connection.ssl).toEqual({ rejectUnauthorized: true, ca: certificate });
  });

  it('requires a CA certificate for verify-full', () => {
    expect(() =>
      resolveDatabaseConnection('postgresql://user:pass@db.example.com/app', {
        DATABASE_SSL_MODE: 'verify-full',
      }),
    ).toThrow('requires DATABASE_CA_CERT_PATH or DATABASE_CA_CERT_BASE64');
  });
});
