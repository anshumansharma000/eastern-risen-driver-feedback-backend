import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';

export interface ResolvedDatabaseConnection {
  readonly url: string;
  readonly ssl: false | ConnectionOptions;
  readonly sslMode: DatabaseSslMode;
}

const SSL_QUERY_PARAMETERS = [
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'uselibpqcompat',
] as const;

export function resolveDatabaseConnection(
  rawUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedDatabaseConnection {
  const url = new URL(rawUrl);
  const sslMode = parseSslMode(
    environment.DATABASE_SSL_MODE ?? url.searchParams.get('sslmode') ?? 'disable',
  );
  const certificatePath =
    environment.DATABASE_CA_CERT_PATH ?? url.searchParams.get('sslrootcert') ?? undefined;
  const certificateBase64 = environment.DATABASE_CA_CERT_BASE64;

  for (const parameter of SSL_QUERY_PARAMETERS) url.searchParams.delete(parameter);

  if (sslMode === 'disable') return { url: url.toString(), ssl: false, sslMode };
  if (sslMode === 'require') {
    return { url: url.toString(), ssl: { rejectUnauthorized: false }, sslMode };
  }

  if (certificatePath && certificateBase64) {
    throw new Error('Set only one of DATABASE_CA_CERT_PATH or DATABASE_CA_CERT_BASE64');
  }
  const ca = certificatePath
    ? readFileSync(certificatePath, 'utf8')
    : certificateBase64
      ? Buffer.from(certificateBase64, 'base64').toString('utf8')
      : undefined;
  if (!ca) {
    throw new Error(
      'DATABASE_SSL_MODE=verify-full requires DATABASE_CA_CERT_PATH or DATABASE_CA_CERT_BASE64',
    );
  }

  return { url: url.toString(), ssl: { rejectUnauthorized: true, ca }, sslMode };
}

function parseSslMode(value: string): DatabaseSslMode {
  if (value === 'disable' || value === 'require' || value === 'verify-full') return value;
  throw new Error('DATABASE_SSL_MODE must be disable, require, or verify-full');
}
