import type { Context } from 'hono';
import type { Store } from './db.ts';
import { sessionActor, tokenActor } from './auth.ts';
import { oauthActor } from './oauth.ts';
export function credentialActor(s: Store, c: Context) {
  const authorization=c.req.header('Authorization');
  return authorization ? tokenActor(s,authorization) ?? oauthActor(s,authorization) ?? sessionActor(s,c) : sessionActor(s,c);
}
