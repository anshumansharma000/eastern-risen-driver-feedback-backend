import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
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
  logger:
    config.nodeEnv === 'development'
      ? {
          level: config.logLevel,
          transport: { target: 'pino-pretty', options: { colorize: true } },
        }
      : { level: config.logLevel },
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await database.close();
  process.exit(0);
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
