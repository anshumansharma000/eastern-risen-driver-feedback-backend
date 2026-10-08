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

describe('Cashfree configuration', () => {
  it('requires a complete credential set and parses the optional webhook URL', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://localhost/test', CASHFREE_APP_ID: 'app' }),
    ).toThrow('must be configured together');
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      CASHFREE_ENV: 'sandbox',
      CASHFREE_APP_ID: 'app',
      CASHFREE_SECRET_KEY: 'secret',
      CASHFREE_WEBHOOK_URL: 'https://api.example.com/api/v1/core/payments/webhooks/cashfree',
    });
    expect(config.cashfree).toEqual({
      environment: 'sandbox',
      appId: 'app',
      secretKey: 'secret',
      webhookUrl: 'https://api.example.com/api/v1/core/payments/webhooks/cashfree',
    });
  });
});

const productionR2Environment = {
  R2_ACCOUNT_ID: 'account-id',
  R2_BUCKET_NAME: 'easternrisen',
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
};

describe('customer email configuration', () => {
  const base = { DATABASE_URL: 'postgresql://localhost/test' };
  const resend = {
    ...base,
    CUSTOMER_ACCOUNT_URL: 'https://portal.example.com/account',
    CUSTOMER_MAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 'test-key',
    CUSTOMER_MAIL_FROM: 'Accounts <accounts@example.com>',
  };
  it('keeps manual mode available with no email credentials', () => {
    expect(loadConfig(base).customerMail).toBeNull();
  });
  it('loads Resend and enables the in-process worker by default', () => {
    expect(loadConfig(resend)).toMatchObject({
      customerMail: { provider: 'resend', apiKey: 'test-key', from: resend.CUSTOMER_MAIL_FROM },
      customerMailWorkerEnabled: true,
      customerMailPollIntervalMs: 10000,
    });
    expect(
      loadConfig({
        ...resend,
        CUSTOMER_MAIL_REPLY_TO: 'help@example.com',
        CUSTOMER_MAIL_WORKER_ENABLED: 'false',
      }),
    ).toMatchObject({
      customerMail: { replyTo: 'help@example.com' },
      customerMailWorkerEnabled: false,
    });
  });
  it.each(['RESEND_API_KEY', 'CUSTOMER_MAIL_FROM', 'CUSTOMER_ACCOUNT_URL'])(
    'rejects incomplete Resend configuration: %s',
    (key) => {
      expect(() => loadConfig({ ...resend, [key]: '' })).toThrow();
    },
  );
  it('requires an explicit supported provider for new integrations', () => {
    expect(() => loadConfig({ ...resend, CUSTOMER_MAIL_PROVIDER: '' })).toThrow(
      'CUSTOMER_MAIL_PROVIDER',
    );
    expect(() => loadConfig({ ...resend, CUSTOMER_MAIL_PROVIDER: 'unknown' })).toThrow(
      'CUSTOMER_MAIL_PROVIDER',
    );
  });
  it.each([
    'bad-address',
    'a@example.com\r\nBcc: b@example.com',
    'a@example.com,b@example.com',
    'Name <a@example.com',
  ])('rejects unsafe sender values: %s', (from) => {
    expect(() => loadConfig({ ...resend, CUSTOMER_MAIL_FROM: from })).toThrow('CUSTOMER_MAIL_FROM');
  });
  it('preserves existing relay deployments and supports configuration-only switching', () => {
    const relay = {
      ...base,
      CUSTOMER_ACCOUNT_URL: resend.CUSTOMER_ACCOUNT_URL,
      CUSTOMER_MAIL_ENDPOINT: 'https://relay.example.com/mail',
      CUSTOMER_MAIL_TOKEN: 'token',
    };
    expect(loadConfig(relay).customerMail).toEqual({
      provider: 'relay',
      endpoint: relay.CUSTOMER_MAIL_ENDPOINT,
      token: 'token',
    });
    expect(
      loadConfig({ ...resend, ...relay, CUSTOMER_MAIL_PROVIDER: 'relay' }).customerMail?.provider,
    ).toBe('relay');
  });
  it('rejects invalid worker settings', () => {
    expect(() => loadConfig({ ...base, CUSTOMER_MAIL_WORKER_ENABLED: 'yes' })).toThrow();
    expect(() => loadConfig({ ...base, CUSTOMER_MAIL_POLL_INTERVAL_MS: '0' })).toThrow();
  });
});

describe('payment reconciliation configuration', () => {
  it('enables the worker by default and accepts explicit overrides', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost/test',
    });
    expect(config.paymentReconciliationWorkerEnabled).toBe(true);
    expect(config.paymentReconciliationPollIntervalMs).toBe(1000);
    const disabled = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      PAYMENT_RECONCILIATION_WORKER_ENABLED: 'false',
      PAYMENT_RECONCILIATION_POLL_INTERVAL_MS: '5000',
    });
    expect(disabled.paymentReconciliationWorkerEnabled).toBe(false);
    expect(disabled.paymentReconciliationPollIntervalMs).toBe(5000);
  });
  it('rejects malformed settings', () => {
    for (const settings of [
      { PAYMENT_RECONCILIATION_WORKER_ENABLED: 'yes' },
      { PAYMENT_RECONCILIATION_POLL_INTERVAL_MS: '0' },
    ]) {
      expect(() =>
        loadConfig({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://test:test@localhost/test',
          ...settings,
        }),
      ).toThrow();
    }
  });
});
