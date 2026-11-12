import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be a valid port number.');
}
const app = createApp({ dataDir: process.env.CAIRN_DATA_DIR ?? './data' });
serve({ fetch: app.fetch, port }, info => console.log(`Cairn listening on port ${info.port}`));
