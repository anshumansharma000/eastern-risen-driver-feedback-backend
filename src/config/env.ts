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
  readonly sessionCookieName: string;
  readonly sessionTtlHours: number;
  readonly frontendOrigins: readonly string[];
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

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnvironment(environment.NODE_ENV);
  const databaseUrl = environment.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const databaseConnection = resolveDatabaseConnection(databaseUrl, environment);

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
    sessionCookieName: environment.SESSION_COOKIE_NAME ?? 'id',
    sessionTtlHours: parsePositiveInteger('SESSION_TTL_HOURS', environment.SESSION_TTL_HOURS, 12),
    frontendOrigins: parseOrigins(environment.FRONTEND_ORIGINS),
  };
}

function parseOrigins(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(',').map((candidate) => new URL(candidate.trim()).origin))];
}
