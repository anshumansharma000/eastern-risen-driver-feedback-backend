import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, type ErrorDetails } from '../shared/errors/app-error.js';

interface ValidationErrorLike {
  readonly validation: unknown;
  readonly validationContext?: unknown;
}

interface HttpErrorLike {
  readonly statusCode: number;
}

function isValidationError(error: unknown): error is ValidationErrorLike {
  return typeof error === 'object' && error !== null && 'validation' in error;
}

function isClientHttpError(error: unknown): error is HttpErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}

const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setNotFoundHandler(async (request, reply) => {
    request.log.info({ errorCode: 'ROUTE_NOT_FOUND', statusCode: 404 }, 'Request route not found');
    await reply
      .status(404)
      .send(
        errorResponse(
          'ROUTE_NOT_FOUND',
          `Route ${request.method} ${request.url} was not found`,
          `No route is registered for ${request.method} ${request.url}.`,
          request.id,
        ),
      );
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      logAppError(error, request.log);
      await reply
        .status(error.statusCode)
        .send(
          errorResponse(
            error.code,
            error.message,
            error.developerMessage,
            request.id,
            error.details,
          ),
        );
      return;
    }

    if (isValidationError(error)) {
      const details = normalizeValidationDetails(error.validation, error.validationContext);
      request.log.warn(
        {
          errorCode: 'REQUEST_VALIDATION_FAILED',
          statusCode: 400,
          validationFields: details.fields.map((field) => field.field),
        },
        'Request validation failed',
      );
      await reply
        .status(400)
        .send(
          errorResponse(
            'REQUEST_VALIDATION_FAILED',
            'Please correct the highlighted fields and try again',
            'One or more request fields failed schema validation. Inspect error.details.fields.',
            request.id,
            details,
          ),
        );
      return;
    }

    if (isClientHttpError(error)) {
      const normalized = normalizeClientHttpError(error.statusCode);
      request.log.warn(
        { errorCode: normalized.code, statusCode: error.statusCode },
        'Request rejected by HTTP framework',
      );
      await reply
        .status(error.statusCode)
        .send(
          errorResponse(
            normalized.code,
            normalized.message,
            normalized.developerMessage,
            request.id,
          ),
        );
      return;
    }

    request.log.error(
      { err: error, errorCode: 'INTERNAL_SERVER_ERROR', statusCode: 500 },
      'Unhandled request error',
    );
    await reply
      .status(500)
      .send(
        errorResponse(
          'INTERNAL_SERVER_ERROR',
          'Something went wrong. Please try again later',
          'An unexpected server-side error occurred. Use requestId to locate the server log.',
          request.id,
        ),
      );
  });
};

function normalizeClientHttpError(statusCode: number) {
  if (statusCode === 413) {
    return {
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'The submitted information is too large',
      developerMessage: 'The request exceeded the configured HTTP body-size limit.',
    };
  }
  if (statusCode === 415) {
    return {
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'This type of request is not supported',
      developerMessage: 'The Content-Type header is not supported by this endpoint.',
    };
  }
  if (statusCode === 429) {
    return {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many attempts. Please wait a moment and try again',
      developerMessage: 'The request was rejected by the configured rate limit.',
    };
  }
  return {
    code: 'REQUEST_REJECTED',
    message: 'The request could not be accepted',
    developerMessage: `The HTTP framework rejected the request with status ${statusCode}.`,
  };
}

function errorResponse(
  code: string,
  message: string,
  developerMessage: string,
  requestId: string,
  details?: ErrorDetails,
) {
  return {
    error: {
      code,
      message,
      developerMessage,
      ...(details === undefined ? {} : { details }),
      requestId,
    },
  };
}

function logAppError(error: AppError, log: Parameters<FastifyPluginAsync>[0]['log']): void {
  const context = { err: error, errorCode: error.code, statusCode: error.statusCode };
  if (error.statusCode >= 500) {
    log.error(context, 'Request failed with application error');
    return;
  }
  log.warn({ errorCode: error.code, statusCode: error.statusCode }, 'Request rejected');
}

interface NormalizedValidationField {
  readonly [key: string]: ErrorDetails;
  readonly field: string;
  readonly message: string;
  readonly rule: string;
}

function normalizeValidationDetails(
  validation: unknown,
  validationContext: unknown,
): { readonly fields: readonly NormalizedValidationField[] } {
  const context = typeof validationContext === 'string' ? validationContext : 'request';
  if (!Array.isArray(validation)) {
    return { fields: [{ field: context, message: 'The value is invalid', rule: 'validation' }] };
  }

  const fields = validation.map((issue): NormalizedValidationField => {
    if (typeof issue !== 'object' || issue === null) {
      return { field: context, message: 'The value is invalid', rule: 'validation' };
    }
    const record = issue as Record<string, unknown>;
    const rule = typeof record.keyword === 'string' ? record.keyword : 'validation';
    const path = typeof record.instancePath === 'string' ? pointerToPath(record.instancePath) : '';
    const affectedProperty = getAffectedProperty(record.params);
    const fieldPath = [context, path, affectedProperty].filter(Boolean).join('.');
    return {
      field: fieldPath || context,
      message: friendlyValidationMessage(rule, record.params, record.message),
      rule,
    };
  });

  return {
    fields: fields.length
      ? fields
      : [{ field: context, message: 'The value is invalid', rule: 'validation' }],
  };
}

function pointerToPath(pointer: string): string {
  return pointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .filter(Boolean)
    .join('.');
}

function getAffectedProperty(params: unknown): string {
  if (typeof params !== 'object' || params === null) return '';
  if ('missingProperty' in params && typeof params.missingProperty === 'string') {
    return params.missingProperty;
  }
  if ('additionalProperty' in params && typeof params.additionalProperty === 'string') {
    return params.additionalProperty;
  }
  return '';
}

function friendlyValidationMessage(rule: string, params: unknown, message: unknown): string {
  if (rule === 'required') return 'This field is required';
  if (rule === 'additionalProperties') return 'This field is not allowed';
  if (rule === 'enum') return 'Select a supported value';
  if (rule === 'pattern') return 'Enter a value in the expected format';
  if (rule === 'format') {
    const format = readValidationParameter(params, 'format');
    if (format === 'email') return 'Enter a valid email address';
    if (format === 'date-time') return 'Enter a valid date and time';
    if (format === 'uuid') return 'Enter a valid identifier';
    return 'Enter a valid value';
  }
  const limit = readValidationParameter(params, 'limit');
  if (rule === 'minLength' && limit !== undefined) return `Use at least ${limit} characters`;
  if (rule === 'maxLength' && limit !== undefined) return `Use no more than ${limit} characters`;
  if (rule === 'minimum' && limit !== undefined) return `Enter a value of at least ${limit}`;
  if (rule === 'maximum' && limit !== undefined) return `Enter a value no greater than ${limit}`;

  const normalized = typeof message === 'string' ? message.replace(/^must\s+/u, '').trim() : '';
  return normalized
    ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`
    : 'The value is invalid';
}

function readValidationParameter(params: unknown, name: string): string | number | undefined {
  if (typeof params !== 'object' || params === null || !(name in params)) return undefined;
  const value = params[name as keyof typeof params];
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
