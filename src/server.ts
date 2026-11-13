import http from 'http';
import { env } from './config/env';
import { connectDb, disconnectDb } from './config/db';
import { logger } from './lib/logger';
import { createApp } from './app';

async function main() {
  await connectDb();
  const app = createApp();
  const server = http.createServer(app);
  // Request timeouts (manual 2.2): never hold a socket forever.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Enile CRM API listening'));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
