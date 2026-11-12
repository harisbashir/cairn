import type { MiddlewareHandler } from 'hono';
import type { Store } from './db.ts';
import { fail, type Env } from './common.ts';
import { credentialActor } from './credentials.ts';

export function apiAuthentication(store: Store): MiddlewareHandler<Env> {
  return async (c, next) => {
    const path = c.req.path.replace(/^\/api\/v1(?=\/|$)/, '/api');
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const bearer = /^Bearer \S+$/i.test(c.req.header('Authorization') ?? '');
    if (mutating && !bearer && !c.req.header('X-Cairn-Client')?.trim()) fail(400, 'X-Cairn-Client is required for changes.');
    const isPublic = ['/api/bootstrap', '/api/auth/signup', '/api/auth/login', '/api/openapi.json', '/api/health'].includes(path)
      || (c.req.method === 'GET' && (/^\/api\/invites\/[^/]+$/.test(path) || path.startsWith('/api/public/')));
    const actor = credentialActor(store, c);
    if (actor) c.set('actor', actor);
    if (!isPublic && !actor) fail(401, 'Please sign in to continue.');
    if (actor?.access === 'read' && mutating) fail(403, 'This token is read only.');
    // Scoped credentials cannot mint unscoped credentials or administer the instance.
    if (actor?.workspaceId && (/^\/api\/(admin|tokens|connected-apps|oauth|me)(\/|$)/.test(path)
      || (path === '/api/workspaces' && mutating))) fail(403, 'This token is workspace scoped.');
    if (path.startsWith('/api/admin/backups') && actor?.access === 'read') fail(403, 'Read-only credentials cannot access backup archives.');
    if (path.startsWith('/api/admin/') && !actor?.user.isAdmin) fail(403, 'Instance administrator access is required.');
    await next();
  };
}
