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
// Live-update streams never end on their own, so drop open connections instead of waiting for them; otherwise
// `docker stop` runs out its grace period, SIGKILLs the server and leaves the lock file behind.
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
  server.close(()=>process.exit(0));
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  setTimeout(()=>process.exit(0),3000).unref();
});
