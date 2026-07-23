import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../shared/errors/app-error.js';

interface ValidationErrorLike {
  readonly validation: unknown;
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
    await reply
      .status(404)
      .send(
        errorResponse(
          'ROUTE_NOT_FOUND',
          `Route ${request.method} ${request.url} was not found`,
          request.id,
        ),
      );
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      await reply
        .status(error.statusCode)
        .send(errorResponse(error.code, error.message, request.id, error.details));
      return;
    }

    if (isValidationError(error)) {
      await reply
        .status(400)
        .send(
          errorResponse(
            'REQUEST_VALIDATION_FAILED',
            'The request did not pass validation',
            request.id,
            error.validation,
          ),
        );
      return;
    }

    if (isClientHttpError(error)) {
      const normalized = normalizeClientHttpError(error.statusCode);
      await reply
        .status(error.statusCode)
        .send(errorResponse(normalized.code, normalized.message, request.id));
      return;
    }

    request.log.error({ err: error }, 'Unhandled request error');
    await reply
      .status(500)
      .send(errorResponse('INTERNAL_SERVER_ERROR', 'An unexpected error occurred', request.id));
  });
};

function normalizeClientHttpError(statusCode: number) {
  if (statusCode === 413) {
    return { code: 'REQUEST_BODY_TOO_LARGE', message: 'The request body is too large' };
  }
  if (statusCode === 415) {
    return { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The request media type is unsupported' };
  }
  if (statusCode === 429) {
    return { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests; try again later' };
  }
  return { code: 'REQUEST_REJECTED', message: 'The request could not be accepted' };
}

function errorResponse(code: string, message: string, requestId: string, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      requestId,
    },
  };
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
