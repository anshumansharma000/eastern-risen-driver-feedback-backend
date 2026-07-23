import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { loggerRedaction } from './config/logger.js';
import { createApplicationServices } from './container.js';
import { createDatabaseClient } from './database/client.js';

const config = loadConfig();
const database = createDatabaseClient(config);
const services = createApplicationServices(database.db, config);
const app = await buildApp({
  databaseHealthCheck: () => database.checkHealth(),
  exposeDocs: config.nodeEnv !== 'production',
  services,
  allowedOrigins: config.frontendOrigins,
  trustProxy: config.trustProxyHops > 0 ? config.trustProxyHops : false,
  connectionTimeoutMs: config.connectionTimeoutMs,
  requestTimeoutMs: config.requestTimeoutMs,
  keepAliveTimeoutMs: config.keepAliveTimeoutMs,
  bodyLimitBytes: config.bodyLimitBytes,
  logger:
    config.nodeEnv === 'development'
      ? {
          level: config.logLevel,
          redact: loggerRedaction,
          transport: { target: 'pino-pretty', options: { colorize: true } },
        }
      : { level: config.logLevel, redact: loggerRedaction },
});

const shutdownDeadline = () =>
  new Promise<never>((_resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Graceful shutdown timed out')),
      config.shutdownTimeoutMs,
    );
    timeout.unref();
  });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down');
  try {
    await Promise.race([
      (async () => {
        await app.close();
        await database.close();
      })(),
      shutdownDeadline(),
    ]);
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'Failed to start server');
  await database.close();
  process.exit(1);
}
