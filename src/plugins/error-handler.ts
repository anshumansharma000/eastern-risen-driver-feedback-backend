import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../shared/errors/app-error.js';

interface ValidationErrorLike {
  readonly validation: unknown;
}

function isValidationError(error: unknown): error is ValidationErrorLike {
  return typeof error === 'object' && error !== null && 'validation' in error;
}

const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setNotFoundHandler(async (request, reply) => {
    await reply.status(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Route ${request.method} ${request.url} was not found`,
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      await reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      });
      return;
    }

    if (isValidationError(error)) {
      await reply.status(400).send({
        error: {
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'The request did not pass validation',
          details: error.validation,
          requestId: request.id,
        },
      });
      return;
    }

    request.log.error({ err: error }, 'Unhandled request error');
    await reply.status(500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        requestId: request.id,
      },
    });
  });
};

export default fp(errorHandlerPlugin, { name: 'error-handler' });
