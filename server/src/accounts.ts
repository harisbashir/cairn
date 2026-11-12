import type { Hono } from 'hono';
import type { Store } from './db.ts';
import type { Actor, Env } from './common.ts';
import { registerAuthRoutes } from './auth-routes.ts';
import { registerWorkspaces } from './workspaces.ts';
import { registerAdmin } from './admin.ts';

export function registerAccounts(
  app: Hono<Env>,
  store: Store,
  seed: (workspaceId: string, actor: Actor, title: string) => void,
  deleteWorkspace: (workspaceId: string) => void,
  emitMembers: (workspaceId: string) => void = () => {},
) {
  registerAuthRoutes(app, store, seed, emitMembers);
  registerWorkspaces(app, store, seed, deleteWorkspace, emitMembers);
  registerAdmin(app, store, deleteWorkspace);
}
