import type { Context } from 'hono';
import { z } from 'zod';
import type { User, ActorType, Role } from '../../shared/types.ts';
import type { Store } from './db.ts';

type ErrorStatus = 400 | 401 | 403 | 404 | 409;
export class ApiException extends Error {
  constructor(public status: ErrorStatus, message: string) { super(message); }
}
export function fail(status: ErrorStatus, message: string): never {
  throw new ApiException(status, message);
}
export interface Actor {
  user: User;
  actorType: ActorType;
  clientId: string | null;
  clientName?: string | null;
  requestOrigin?: string;
  access?: 'read' | 'write';
  workspaceId?: string | null;
}
export type Env = { Variables: { actor: Actor } };

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let value: unknown;
  try { value = await c.req.json(); }
  catch { return fail(400, 'A valid JSON body is required.'); }
  const result = schema.safeParse(value);
  if (!result.success) return fail(400, result.error.issues.map(issue => issue.message).join('; '));
  return result.data;
}

export interface Membership {
  workspaceId: string;
  userId: string;
  role: Role;
  joinedAt: string;
}
export function membership(s: Store, actor: Actor, wid: string, write = false, manage = false): Membership {
  const currentUser=s.get('users',actor.user.id);
  if(!currentUser||currentUser.disabled)fail(401,'Please sign in to continue.');
  if (actor.workspaceId && actor.workspaceId !== wid) {
    fail(403, 'This token is limited to another workspace.');
  }
  const member = s.db.prepare(
    'SELECT * FROM memberships WHERE workspaceId=? AND userId=?',
  ).get(wid, actor.user.id) as unknown as Membership | undefined;
  if (!member) return fail(403, 'You are not a member of this workspace.');
  if ((write && (member.role === 'viewer' || actor.access === 'read'))
      || (manage && !['owner', 'admin'].includes(member.role))) {
    fail(403, 'Your role does not permit this action.');
  }
  return member;
}

export function publicUser(user: User & { passwordHash?: string; salt?: string }): User {
  const { passwordHash, salt, ...value } = user;
  return { ...value, prefs: Object.assign({ theme: 'system' as const, accent: 'blue' as const, timezone: 'UTC', reminderHour: 9, capture: null }, value.prefs, {notify:Object.assign({push:true,email:false,mentions:true,comments:true,assigned:true},value.prefs?.notify)}) };
}

export function publicUrl(c: Context, path = ''): string {
  return (process.env.CAIRN_PUBLIC_URL ?? ((c.req.header('X-Forwarded-Proto') ?? new URL(c.req.url).protocol.slice(0,-1)) + '://' + (c.req.header('X-Forwarded-Host') ?? new URL(c.req.url).host))).replace(/\/+$/, '') + path;
}
