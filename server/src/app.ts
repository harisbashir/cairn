import { Hono } from 'hono';
import { Store } from './db.ts';
import { ApiException, type Env, fail } from './common.ts';
import { sessionActor } from './auth.ts';
import { registerAccounts } from './accounts.ts';
import { Pages, registerPages } from './pages.ts';
import { Events } from './events.ts';
import { registerEvents } from './event-routes.ts';
import { registerAssets, registerStatic } from './assets.ts';
import { registerMcp } from './mcp.ts';

export function createApp({ dataDir }: { dataDir: string }) {
  const app = new Hono<Env>();
  const store = new Store(dataDir);
  const events = new Events();
  const pages = new Pages(store, events);

  app.onError((error, c) => {
    if (error instanceof ApiException) {
      const codes = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };
      return c.json({ error: { code: codes[error.status], message: error.message } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: 'internal', message: 'An unexpected server error occurred.' } }, 500);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Resource not found.' } }, 404));

  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !c.req.header('X-Cairn-Client')?.trim()) {
      fail(400, 'X-Cairn-Client is required for changes.');
    }
    const path = c.req.path;
    const isPublic = path === '/api/bootstrap' || path === '/api/auth/signup' || path === '/api/auth/login'
      || (c.req.method === 'GET' && (/^\/api\/invites\/[^/]+$/.test(path) || path.startsWith('/api/public/')));
    const actor = sessionActor(store, c);
    if (actor) c.set('actor', actor);
    if (!isPublic && !actor) fail(401, 'Please sign in to continue.');
    await next();
  });

  registerAccounts(app, store,
    (wid, actor, title) => { pages.create(actor, wid, { title }); },
    wid => pages.deleteWorkspace(wid),
    wid => events.emit(wid, { type: 'members' }),
  );
  registerPages(app, pages);
  registerEvents(app, pages);
  registerAssets(app, pages);
  registerMcp(app, pages);
  registerStatic(app);
  return app;
}
