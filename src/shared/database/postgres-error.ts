interface PostgresErrorLike {
  readonly code: string;
  readonly constraint?: string;
}

export function isPostgresError(error: unknown, code: string): error is PostgresErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
  );
}
