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
      passengerFeedbackUrl: 'http://localhost:3001/feedback',
      frontendOrigins: [],
      trustProxyHops: 0,
      requestTimeoutMs: 30_000,
      bodyLimitBytes: 1_048_576,
      r2: null,
    });
  });

  it('loads and validates the public passenger feedback URL', () => {
    expect(
      loadConfig({
        DATABASE_URL: 'postgresql://localhost/test',
        PASSENGER_FEEDBACK_URL: 'https://feedback.example.com/form?source=shared',
      }).passengerFeedbackUrl,
    ).toBe('https://feedback.example.com/form?source=shared');

    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://localhost/test',
        PASSENGER_FEEDBACK_URL: '/feedback',
      }),
    ).toThrow('PASSENGER_FEEDBACK_URL must be a valid absolute URL');
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

  it('loads a bucket-scoped R2 photo storage configuration', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      R2_ACCOUNT_ID: 'account-id',
      R2_BUCKET_NAME: 'easternrisen',
      R2_KEY_PREFIX: '/feedbackphotos/',
      R2_ACCESS_KEY_ID: 'access-key',
      R2_SECRET_ACCESS_KEY: 'secret-key',
    });

    expect(config.r2).toMatchObject({
      bucketName: 'easternrisen',
      keyPrefix: 'feedbackphotos',
      endpoint: 'https://account-id.r2.cloudflarestorage.com/',
      uploadUrlTtlSeconds: 600,
      downloadUrlTtlSeconds: 300,
      maxUploadBytes: 10_485_760,
      orphanTtlHours: 24,
    });
  });

  it('rejects a partial R2 configuration', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://localhost/test',
        R2_ACCOUNT_ID: 'account-id',
      }),
    ).toThrow('R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY must be configured together');
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
      PASSENGER_FEEDBACK_URL: 'https://feedback.example.com/feedback',
      ...productionR2Environment,
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
        PASSENGER_FEEDBACK_URL: 'https://feedback.example.com/feedback',
        DATA_ENCRYPTION_KEY_BASE64: encryptionKey,
        ...productionR2Environment,
      }),
    ).toThrow('DATABASE_SSL_MODE must require TLS in production');
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/test',
        DATABASE_SSL_MODE: 'require',
        PASSENGER_FEEDBACK_URL: 'https://feedback.example.com/feedback',
        DATA_ENCRYPTION_KEY_BASE64: encryptionKey,
        ...productionR2Environment,
      }),
    ).toThrow('FRONTEND_ORIGINS is required in production');
  });

  it('requires the public passenger feedback URL in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/test',
        DATABASE_SSL_MODE: 'require',
        FRONTEND_ORIGINS: 'https://feedback.example.com',
        DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
        ...productionR2Environment,
      }),
    ).toThrow('PASSENGER_FEEDBACK_URL is required in production');
  });

  it('requires R2 photo storage in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/test',
        DATABASE_SSL_MODE: 'require',
        FRONTEND_ORIGINS: 'https://feedback.example.com',
        PASSENGER_FEEDBACK_URL: 'https://feedback.example.com/feedback',
        DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
      }),
    ).toThrow(
      'R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required in production',
    );
  });
});

const productionR2Environment = {
  R2_ACCOUNT_ID: 'account-id',
  R2_BUCKET_NAME: 'easternrisen',
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
};
