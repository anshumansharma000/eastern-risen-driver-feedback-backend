import type { FastifyPluginAsync, FastifySchema } from 'fastify';
import fp from 'fastify-plugin';
import { errorResponseSchema } from '../shared/http/response.schemas.js';

const errorSchemaReference = { $ref: 'ErrorResponse#' } as const;
const standardErrorResponses = {
  400: errorSchemaReference,
  401: errorSchemaReference,
  403: errorSchemaReference,
  404: errorSchemaReference,
  409: errorSchemaReference,
  413: errorSchemaReference,
  415: errorSchemaReference,
  422: errorSchemaReference,
  429: errorSchemaReference,
  500: errorSchemaReference,
} as const;

const responseContractPlugin: FastifyPluginAsync = async (app) => {
  app.addSchema(errorResponseSchema);

  app.addHook('onRoute', (routeOptions) => {
    const schema: FastifySchema = routeOptions.schema ?? {};
    const responses = (schema.response ?? {}) as Record<string, unknown>;
    routeOptions.schema = {
      ...schema,
      response: { ...standardErrorResponses, ...responses },
    };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });
};

export default fp(responseContractPlugin, { name: 'response-contract' });
