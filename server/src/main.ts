import { serve } from '@hono/node-server';
import { acquireServerLock } from './backups.ts';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be a valid port number.');
}
const dataDir=process.env.CAIRN_DATA_DIR ?? './data';
const releaseLock=acquireServerLock(dataDir);
process.once('exit',releaseLock);
const app = createApp({ dataDir });
const server=serve({ fetch: app.fetch, port }, info => console.log(`Cairn listening on port ${info.port}`));

server.once('close',releaseLock);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>server.close(()=>process.exit(0)));
