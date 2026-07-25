import { describe, expect, it } from 'vitest';
import { loadConfig } from './env.js';

describe('loadConfig', () => {
  it('loads defaults and required database configuration', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://localhost/test' });

    expect(config).toMatchObject({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      databaseMaxConnections: 10,
      databaseConnectionTimeoutMs: 10_000,
      databaseStatementTimeoutMs: 30_000,
      sessionCookieName: 'id',
      sessionIdleTtlHours: 72,
      sessionAbsoluteTtlDays: 30,
      sessionRotationIntervalHours: 24,
      sessionRotationGraceSeconds: 60,
      frontendOrigins: [],
      trustProxyHops: 0,
      requestTimeoutMs: 30_000,
      bodyLimitBytes: 1_048_576,
    });
  });

  it('normalizes configured frontend origins', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      FRONTEND_ORIGINS: 'https://app.example.com/, http://localhost:3001',
    });

    expect(config.frontendOrigins).toEqual(['https://app.example.com', 'http://localhost:3001']);
  });

  it('rejects a missing database URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
  });

  it('rejects invalid positive integer settings', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://localhost/test', PORT: 'not-a-port' }),
    ).toThrow('PORT must be a positive integer');
  });

  it('requires token rotation before the inactivity deadline', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://localhost/test',
        SESSION_IDLE_TTL_HOURS: '12',
        SESSION_ROTATION_INTERVAL_HOURS: '12',
      }),
    ).toThrow('SESSION_ROTATION_INTERVAL_HOURS must be less than SESSION_IDLE_TTL_HOURS');
  });

  it('requires a 32-byte data-encryption key in production', () => {
    const productionEnvironment = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://localhost/test',
      DATABASE_SSL_MODE: 'require',
      FRONTEND_ORIGINS: 'https://feedback.example.com',
    };
    expect(() => loadConfig(productionEnvironment)).toThrow(
      'DATA_ENCRYPTION_KEY_BASE64 is required in production',
    );
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
      }),
    ).not.toThrow();
  });

  it('requires TLS and a frontend origin in production', () => {
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/test',
        FRONTEND_ORIGINS: 'https://feedback.example.com',
        DATA_ENCRYPTION_KEY_BASE64: encryptionKey,
      }),
    ).toThrow('DATABASE_SSL_MODE must require TLS in production');
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/test',
        DATABASE_SSL_MODE: 'require',
        DATA_ENCRYPTION_KEY_BASE64: encryptionKey,
      }),
    ).toThrow('FRONTEND_ORIGINS is required in production');
  });
});
