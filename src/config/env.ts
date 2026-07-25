import type { ConnectionOptions } from 'node:tls';
import { resolveDatabaseConnection, type DatabaseSslMode } from './database-connection.js';

export type NodeEnvironment = 'development' | 'test' | 'production';

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
  readonly dataEncryptionKey: Buffer;
  readonly frontendOrigins: readonly string[];
  readonly trustProxyHops: number;
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly bodyLimitBytes: number;
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
  };
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
