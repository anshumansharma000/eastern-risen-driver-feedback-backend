export interface AppErrorOptions {
  readonly code: string;
  readonly message: string;
  /** Safe to return to API consumers. Never include secrets, PII, queries, or stack traces. */
  readonly developerMessage?: string;
  readonly statusCode: number;
  readonly details?: ErrorDetails;
  readonly cause?: unknown;
}

export type ErrorDetails =
  | string
  | number
  | boolean
  | null
  | readonly ErrorDetails[]
  | { readonly [key: string]: ErrorDetails };

export class AppError extends Error {
  readonly code: string;
  readonly developerMessage: string;
  readonly statusCode: number;
  readonly details: ErrorDetails | undefined;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.developerMessage =
      options.developerMessage ??
      `The server rejected the request with error code ${options.code}.`;
    this.statusCode = options.statusCode;
    this.details = options.details;
  }
}
