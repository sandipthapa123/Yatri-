import { createServer } from 'node:http';

import { createApp } from './app';
import { assertUtf8Database } from './config/database';
import { env } from './config/env';
import { attachRealtimeGateway } from './modules/realtime/gateway';
import { refreshSettings } from './modules/settings/settings.service';

const app = createApp();
const server = createServer(app);

async function main() {
  await assertUtf8Database();
  await refreshSettings();
  const gateway = await attachRealtimeGateway(server);

  server.listen(env.PORT, () => {
    console.log(`Yatri API listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = () => {
    void gateway.close().finally(() => server.close(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start API', err);
  process.exit(1);
});
