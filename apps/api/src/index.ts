import { createServer } from 'node:http';

import { createApp } from './app';
import { assertUtf8Database, pool } from './config/database';
import { env } from './config/env';
import { closeRedis } from './config/redis';
import { log } from './lib/logger';
import { attachRealtimeGateway } from './modules/realtime/gateway';
import { refreshSettings } from './modules/settings/settings.service';

const app = createApp();
const server = createServer(app);

async function main() {
  await assertUtf8Database();
  await refreshSettings();
  const gateway = await attachRealtimeGateway(server);

  server.listen(env.PORT, () => {
    log.info(`Yatri API listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  /**
   * Orderly stop (a deploy, a scale-down, a crash we chose to end): refuse new connections, close
   * realtime sockets, let requests in flight finish, release the database and Redis, then exit. If
   * that takes longer than SHUTDOWN_TIMEOUT_MS the process exits anyway: a supervisor restarts it,
   * and every client re-synchronises from server state on reconnect.
   */
  let stopping = false;
  const shutdown = (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log.info('Shutting down', { reason });
    const force = setTimeout(() => {
      log.error('Shutdown timed out; exiting');
      process.exit(code || 1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    force.unref();
    void gateway
      .close()
      .then(() => new Promise<void>((resolve) => server.close(() => resolve())))
      .then(() => pool.end())
      .then(() => closeRedis())
      .catch((err) => log.error('Error while shutting down', err))
      .finally(() => process.exit(code));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // A bug that escaped every handler: record it and restart cleanly rather than limp on in an unknown state.
  process.on('unhandledRejection', (err) => {
    log.error('Unhandled promise rejection', err);
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', err);
    shutdown('uncaughtException', 1);
  });
}

main().catch((err) => {
  log.error('Failed to start API', err);
  process.exit(1);
});
