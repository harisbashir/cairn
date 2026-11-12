import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Store } from './db.ts';
import { now } from './db.ts';
import { publicUser, type Actor } from './common.ts';

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');
export function passwordFields(password: string) {
  const salt = randomBytes(16).toString('hex');
  return { salt, passwordHash: scryptSync(password, salt, 64).toString('hex') };
}
export function passwordMatches(user: {salt:string;passwordHash:string}, password: string): boolean {
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = scryptSync(password, user.salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function createSession(s: Store, c: Context, userId: string) {
  const secret = randomBytes(32).toString('base64url');
  s.db.prepare('INSERT INTO sessions(hash,userId,expiresAt) VALUES(?,?,?)').run(hashSecret(secret), userId, new Date(Date.now()+30*86400000).toISOString());
  setCookie(c, 'cairn_session', secret, { httpOnly:true, sameSite:'Lax', secure:process.env.CAIRN_SECURE_COOKIES==='1', path:'/', maxAge:30*86400 });
}
export function destroySession(s: Store, c: Context) {
  const secret = getCookie(c, 'cairn_session');
  if (secret) s.db.prepare('DELETE FROM sessions WHERE hash=?').run(hashSecret(secret));
  deleteCookie(c, 'cairn_session', { path:'/' });
}
export function sessionActor(s: Store, c: Context): Actor | undefined {
  const secret = getCookie(c, 'cairn_session');
  if (!secret) return;
  const session = s.db.prepare('SELECT userId FROM sessions WHERE hash=? AND expiresAt>?').get(hashSecret(secret), now());
  if (!session) return;
  const user = s.get('users', String(session.userId));
  if (!user || user.disabled) return;
  return { user:publicUser(user), actorType:'user', clientId:c.req.header('X-Cairn-Client') ?? null };
}
export function tokenActor(s: Store, authorization: string | undefined): Actor | undefined {
  const match = /^Bearer (cairn_[A-Za-z0-9_-]{40})$/i.exec(authorization ?? '');
  if (!match) return;
  const token = s.all('tokens').find(t => t.hash === hashSecret(match[1]));
  if (!token) return;
  const user = s.get('users', token.userId);
  if (!user || user.disabled) return;
  token.lastUsedAt = now();
  s.put('tokens', token);
  return { user:publicUser(user), actorType:'ai', clientId:null, access:token.access, workspaceId:token.workspaceId };
}
