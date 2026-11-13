import type { Context } from 'hono';
import { publicUrl } from './common.ts';
import type { Store } from './db.ts';
import { sessionActor, tokenActor } from './auth.ts';
import { oauthActor } from './oauth.ts';
export function credentialActor(s: Store, c: Context) {
  const authorization=c.req.header('Authorization');
  const actor=authorization ? tokenActor(s,authorization) ?? oauthActor(s,authorization) ?? sessionActor(s,c) : sessionActor(s,c);
  if(actor)actor.requestOrigin=new URL(publicUrl(c)).origin;
  return actor;
}
