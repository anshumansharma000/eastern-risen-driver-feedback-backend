interface PostgresErrorLike {
  readonly code: string;
  readonly constraint?: string;
}

export function isPostgresError(error: unknown, code: string): boolean {
  return findPostgresError(error, code) !== undefined;
}

export function findPostgresError(error: unknown, code: string): PostgresErrorLike | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
    ? (error as PostgresErrorLike)
    : typeof error === 'object' && error !== null && 'cause' in error
      ? findPostgresError(error.cause, code)
      : undefined;
}
