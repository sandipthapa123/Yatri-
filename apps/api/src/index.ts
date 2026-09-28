import { createApp } from './app';
import { env } from './config/env';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`Yatri API listening on port ${env.PORT} (${env.NODE_ENV})`);
});
