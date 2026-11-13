import { Hono } from 'hono';
import { Store } from './db.ts';
import { ApiException, type Env } from './common.ts';
import { apiAuthentication } from './api-auth.ts';
import { hardening } from './http.ts';
import { registerAccounts } from './accounts.ts';
import { Pages, registerPages } from './pages.ts';
import { Events } from './events.ts';
import { registerEvents } from './event-routes.ts';
import { registerAssets, registerStatic } from './assets.ts';
import { registerMcp } from './mcp.ts';
import { registerDashboard } from './dashboard.ts';
import { registerOAuth } from './oauth.ts';
import { registerCalendars } from './calendars.ts';
import { registerTransfer } from './transfer.ts';
import { registerBackups } from './backups.ts';
import { startHousekeeping } from './housekeeping.ts';
import { registerCollaboration } from './collaboration.ts';
import { Notifications, registerNotifications, type NotificationOptions } from './notifications.ts';
import { openapi } from './openapi.ts';

export function createApp({ dataDir, fetch: fetchImpl = globalThis.fetch, notifications: notificationOptions }: { dataDir: string; fetch?: typeof globalThis.fetch; notifications?: NotificationOptions }) {
  const app = new Hono<Env>();
  const store = new Store(dataDir);
  const events = new Events();
  const pages = new Pages(store, events);
  app.onError((error, c) => {
    c.header('X-Content-Type-Options','nosniff'); c.header('Referrer-Policy','same-origin'); c.header('X-Frame-Options','DENY');
    if (error instanceof ApiException) {
      const codes = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };
      return c.json({ error: { code: error.message.startsWith('Choose where quick capture saves') ? 'no_target' : codes[error.status], message: error.message } }, error.status);
    }
    // Error messages from upstream services can contain credentials; never log them.
    return c.json({ error: { code: 'internal', message: 'An unexpected server error occurred.' } }, 500);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Resource not found.' } }, 404));
  app.use('*', hardening);
  app.use('/api/*', apiAuthentication(store));
  app.get('/api/health',c=>c.json({ok:true,version:'0.3.0'}));
  registerAccounts(app, store,
    (wid, actor, title) => { pages.create(actor, wid, { title }); },
    wid => pages.deleteWorkspace(wid), wid => events.emit(wid, { type: 'members' }),
  );
  registerPages(app, pages);
  registerCollaboration(app,pages);
  const notifications=new Notifications(store,pages,events,notificationOptions);
  pages.notifications=notifications;
  registerNotifications(app,notifications);notifications.start();
  registerDashboard(app,pages);
  registerCalendars(app,pages,fetchImpl);
  registerTransfer(app,pages,fetchImpl);
  registerBackups(app,pages,fetchImpl);
  registerOAuth(app,store);
  startHousekeeping(store,pages);
  registerEvents(app, pages);
  registerAssets(app, pages);
  registerMcp(app, pages,fetchImpl);
  app.get('/api/openapi.json',c=>c.json(openapi(app)));
  for(const route of [...app.routes]) if(route.path.startsWith('/api/') && !route.path.includes('*'))app.on(route.method,route.path.replace(/^\/api\//,'/api/v1/'),route.handler);
  registerStatic(app);
  return app;
}
