import type { ConnectionOptions } from 'node:tls';
import { resolveDatabaseConnection, type DatabaseSslMode } from './database-connection.js';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface R2Config {
  readonly accountId: string;
  readonly bucketName: string;
  readonly keyPrefix: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly endpoint: string;
  readonly uploadUrlTtlSeconds: number;
  readonly downloadUrlTtlSeconds: number;
  readonly maxUploadBytes: number;
  readonly orphanTtlHours: number;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly databaseUrl: string;
  readonly databaseSsl: false | ConnectionOptions;
  readonly databaseSslMode: DatabaseSslMode;
  readonly databaseMaxConnections: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly databaseIdleTimeoutMs: number;
  readonly databaseStatementTimeoutMs: number;
  readonly sessionCookieName: string;
  readonly sessionIdleTtlHours: number;
  readonly sessionAbsoluteTtlDays: number;
  readonly sessionRotationIntervalHours: number;
  readonly sessionRotationGraceSeconds: number;
  readonly feedbackHandoffTtlHours: number;
  readonly passengerFeedbackUrl: string;
  readonly dataEncryptionKey: Buffer;
  readonly frontendOrigins: readonly string[];
  readonly trustProxyHops: number;
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly bodyLimitBytes: number;
  readonly r2: R2Config | null;
}

function parseNodeEnvironment(value: string | undefined): NodeEnvironment {
  const environment = value ?? 'development';

  if (!['development', 'test', 'production'].includes(environment)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  return environment as NodeEnvironment;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnvironment(environment.NODE_ENV);
  const databaseUrl = environment.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const databaseConnection = resolveDatabaseConnection(databaseUrl, environment);

  const frontendOrigins = parseOrigins(environment.FRONTEND_ORIGINS);
  if (nodeEnv === 'production' && !environment.PASSENGER_FEEDBACK_URL) {
    throw new Error('PASSENGER_FEEDBACK_URL is required in production');
  }
  const passengerFeedbackUrl = parseUrl(
    'PASSENGER_FEEDBACK_URL',
    environment.PASSENGER_FEEDBACK_URL ?? 'http://localhost:3001/feedback',
  );
  if (nodeEnv === 'production' && databaseConnection.sslMode === 'disable') {
    throw new Error('DATABASE_SSL_MODE must require TLS in production');
  }
  if (nodeEnv === 'production' && frontendOrigins.length === 0) {
    throw new Error('FRONTEND_ORIGINS is required in production');
  }
  const sessionIdleTtlHours = parsePositiveInteger(
    'SESSION_IDLE_TTL_HOURS',
    environment.SESSION_IDLE_TTL_HOURS ?? environment.SESSION_TTL_HOURS,
    72,
  );
  const sessionRotationIntervalHours = parsePositiveInteger(
    'SESSION_ROTATION_INTERVAL_HOURS',
    environment.SESSION_ROTATION_INTERVAL_HOURS,
    24,
  );
  if (sessionRotationIntervalHours >= sessionIdleTtlHours) {
    throw new Error('SESSION_ROTATION_INTERVAL_HOURS must be less than SESSION_IDLE_TTL_HOURS');
  }
  const r2 = parseR2Config(environment, nodeEnv);

  return {
    nodeEnv,
    host: environment.HOST ?? '0.0.0.0',
    port: parsePositiveInteger('PORT', environment.PORT, 3000),
    logLevel: environment.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    databaseUrl: databaseConnection.url,
    databaseSsl: databaseConnection.ssl,
    databaseSslMode: databaseConnection.sslMode,
    databaseMaxConnections: parsePositiveInteger(
      'DATABASE_MAX_CONNECTIONS',
      environment.DATABASE_MAX_CONNECTIONS,
      10,
    ),
    databaseConnectionTimeoutMs: parsePositiveInteger(
      'DATABASE_CONNECTION_TIMEOUT_MS',
      environment.DATABASE_CONNECTION_TIMEOUT_MS,
      10_000,
    ),
    databaseIdleTimeoutMs: parsePositiveInteger(
      'DATABASE_IDLE_TIMEOUT_MS',
      environment.DATABASE_IDLE_TIMEOUT_MS,
      30_000,
    ),
    databaseStatementTimeoutMs: parsePositiveInteger(
      'DATABASE_STATEMENT_TIMEOUT_MS',
      environment.DATABASE_STATEMENT_TIMEOUT_MS,
      30_000,
    ),
    sessionCookieName: environment.SESSION_COOKIE_NAME ?? 'id',
    sessionIdleTtlHours,
    sessionAbsoluteTtlDays: parsePositiveInteger(
      'SESSION_ABSOLUTE_TTL_DAYS',
      environment.SESSION_ABSOLUTE_TTL_DAYS,
      30,
    ),
    sessionRotationIntervalHours,
    sessionRotationGraceSeconds: parsePositiveInteger(
      'SESSION_ROTATION_GRACE_SECONDS',
      environment.SESSION_ROTATION_GRACE_SECONDS,
      60,
    ),
    feedbackHandoffTtlHours: parsePositiveInteger(
      'FEEDBACK_HANDOFF_TTL_HOURS',
      environment.FEEDBACK_HANDOFF_TTL_HOURS,
      168,
    ),
    passengerFeedbackUrl,
    dataEncryptionKey: parseDataEncryptionKey(environment.DATA_ENCRYPTION_KEY_BASE64, nodeEnv),
    frontendOrigins,
    trustProxyHops: parseNonNegativeInteger('TRUST_PROXY_HOPS', environment.TRUST_PROXY_HOPS, 0),
    connectionTimeoutMs: parsePositiveInteger(
      'CONNECTION_TIMEOUT_MS',
      environment.CONNECTION_TIMEOUT_MS,
      10_000,
    ),
    requestTimeoutMs: parsePositiveInteger(
      'REQUEST_TIMEOUT_MS',
      environment.REQUEST_TIMEOUT_MS,
      30_000,
    ),
    keepAliveTimeoutMs: parsePositiveInteger(
      'KEEP_ALIVE_TIMEOUT_MS',
      environment.KEEP_ALIVE_TIMEOUT_MS,
      72_000,
    ),
    shutdownTimeoutMs: parsePositiveInteger(
      'SHUTDOWN_TIMEOUT_MS',
      environment.SHUTDOWN_TIMEOUT_MS,
      10_000,
    ),
    bodyLimitBytes: parsePositiveInteger(
      'BODY_LIMIT_BYTES',
      environment.BODY_LIMIT_BYTES,
      1_048_576,
    ),
    r2,
  };
}

function parseR2Config(environment: NodeJS.ProcessEnv, nodeEnv: NodeEnvironment): R2Config | null {
  const requiredValues = {
    R2_ACCOUNT_ID: environment.R2_ACCOUNT_ID,
    R2_BUCKET_NAME: environment.R2_BUCKET_NAME,
    R2_ACCESS_KEY_ID: environment.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: environment.R2_SECRET_ACCESS_KEY,
  };
  const configured = Object.values(requiredValues).some((value) => Boolean(value?.trim()));
  const missing = Object.entries(requiredValues)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);

  if (!configured) {
    if (nodeEnv === 'production') {
      throw new Error(`${missing.join(', ')} are required in production`);
    }
    return null;
  }
  if (missing.length) throw new Error(`${missing.join(', ')} must be configured together`);

  const accountId = requiredValues.R2_ACCOUNT_ID!.trim();
  const defaultEndpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  return {
    accountId,
    bucketName: requiredValues.R2_BUCKET_NAME!.trim(),
    keyPrefix: normalizeKeyPrefix(environment.R2_KEY_PREFIX ?? 'feedbackphotos'),
    accessKeyId: requiredValues.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: requiredValues.R2_SECRET_ACCESS_KEY!.trim(),
    endpoint: parseUrl('R2_ENDPOINT', environment.R2_ENDPOINT ?? defaultEndpoint),
    uploadUrlTtlSeconds: parsePositiveInteger(
      'R2_UPLOAD_URL_TTL_SECONDS',
      environment.R2_UPLOAD_URL_TTL_SECONDS,
      600,
    ),
    downloadUrlTtlSeconds: parsePositiveInteger(
      'R2_DOWNLOAD_URL_TTL_SECONDS',
      environment.R2_DOWNLOAD_URL_TTL_SECONDS,
      300,
    ),
    maxUploadBytes: parsePositiveInteger(
      'R2_MAX_UPLOAD_BYTES',
      environment.R2_MAX_UPLOAD_BYTES,
      10 * 1024 * 1024,
    ),
    orphanTtlHours: parsePositiveInteger(
      'R2_ORPHAN_TTL_HOURS',
      environment.R2_ORPHAN_TTL_HOURS,
      24,
    ),
  };
}

function normalizeKeyPrefix(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..')) {
    throw new Error('R2_KEY_PREFIX must be a non-empty safe object-key prefix');
  }
  return normalized;
}

function parseUrl(name: string, value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

function parseDataEncryptionKey(value: string | undefined, nodeEnv: NodeEnvironment): Buffer {
  if (!value) {
    if (nodeEnv === 'production') {
      throw new Error('DATA_ENCRYPTION_KEY_BASE64 is required in production');
    }
    return Buffer.alloc(32);
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
  }
  return key;
}

function parseOrigins(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(',').map((candidate) => new URL(candidate.trim()).origin))];
}
