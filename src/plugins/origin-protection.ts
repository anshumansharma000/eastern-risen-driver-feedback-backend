import cors from '@fastify/cors';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../shared/errors/app-error.js';

export interface OriginProtectionOptions {
  readonly allowedOrigins: readonly string[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const originProtection: FastifyPluginAsync<OriginProtectionOptions> = async (app, options) => {
  const allowedOrigins = new Set(options.allowedOrigins);

  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
  });

  app.addHook('onRequest', async (request) => {
    const origin = request.headers.origin;
    if (!SAFE_METHODS.has(request.method) && origin && !allowedOrigins.has(origin)) {
      throw new AppError({
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'The request origin is not allowed',
        statusCode: 403,
      });
    }
  });
};

export default fp(originProtection, { name: 'origin-protection' });
