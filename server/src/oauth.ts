import type { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { id, now, type Store } from './db.ts';
import { body, fail, membership, publicUrl, publicUser, type Actor, type Env } from './common.ts';
import { hashSecret } from './auth.ts';

const secret = () => randomBytes(32).toString('base64url');
const expires = (ms: number) => new Date(Date.now()+ms).toISOString();
export function oauthActor(s: Store, authorization?: string): Actor | undefined {
  const token = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token) return;
  const grant = s.all('oauthGrants').find(g => g.accessHash === hashSecret(token) && g.accessExpiresAt > now());
  if (!grant) return;
  const user = s.get('users',grant.userId);
  if (!user || user.disabled) return;
  grant.lastUsedAt=now(); s.put('oauthGrants',grant);
  return {user:publicUser(user),actorType:'user',clientId:null,access:grant.access,workspaceId:grant.workspaceId};
}
function redirectAllowed(value: string) {
  try { const u = new URL(value); return !u.hash && !u.username && !u.password && (u.protocol==='https:' || (u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)) || (!['http:','https:','javascript:','data:','file:','ftp:'].includes(u.protocol) && /^[a-z][a-z0-9+.-]+:$/.test(u.protocol))); } catch { return false; }
}
export function registerOAuth(app: Hono<Env>, s: Store) {
  for (const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) app.get(path,c=>c.json({resource:publicUrl(c,'/mcp'),authorization_servers:[publicUrl(c)],scopes_supported:['read','write'],bearer_methods_supported:['header']}));
  app.get('/.well-known/oauth-authorization-server',c=>c.json({issuer:publicUrl(c),authorization_endpoint:publicUrl(c,'/oauth/authorize'),token_endpoint:publicUrl(c,'/oauth/token'),registration_endpoint:publicUrl(c,'/oauth/register'),response_types_supported:['code'],code_challenge_methods_supported:['S256'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],scopes_supported:['read','write']}));
  const registrations = new Map<string,number[]>();
  app.post('/oauth/register',async c=>{
    const key=c.req.header('x-forwarded-for')?.split(',')[0] ?? 'local';
    const times=(registrations.get(key)??[]).filter(t=>t>Date.now()-3600000);
    if(times.length>=20)fail(403,'Too many registrations.'); times.push(Date.now()); registrations.set(key,times);
    const v=await body(c,z.object({client_name:z.string().min(1).max(200).default('Application'),redirect_uris:z.array(z.string().max(2048).refine(redirectAllowed,'Invalid redirect URI.')).min(1).max(20),token_endpoint_auth_method:z.literal('none').optional()}));
    const client={id:id(),client_name:v.client_name,redirect_uris:v.redirect_uris,createdAt:now()}; s.put('oauthClients',client);
    return c.json({client_id:client.id,client_name:client.client_name,redirect_uris:client.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},201);
  });
  app.get('/oauth/authorize',c=>{
    const q=c.req.query(), client=s.get('oauthClients',q.client_id ?? '');
    if(!client || !client.redirect_uris.includes(q.redirect_uri))fail(400,'Invalid client or redirect URI.');
    if(q.response_type!=='code'||q.code_challenge_method!=='S256'||!/^[\w-]{43}$/.test(q.code_challenge??'')||!['read','write'].includes(q.scope??'read')||!q.state||q.state.length>2048)fail(400,'Invalid authorization request. S256 PKCE and state are required.');
    const request={id:id(),clientId:client.id,redirectUri:q.redirect_uri,challenge:q.code_challenge,scope:q.scope??'read',state:q.state,expiresAt:expires(600000)};
    s.put('oauthRequests',request); return c.redirect('/oauth/consent?request='+request.id);
  });
  function request(key:string) { const r=s.get('oauthRequests',key); if(!r||r.expiresAt<=now())fail(404,'Authorization request expired.'); return r; }
  function requireSession(a:Actor) { if(a.access)fail(403,'A browser session is required.'); }
  app.get('/api/oauth/requests/:id',c=>{ requireSession(c.get('actor')); const r=request(c.req.param('id')), client=s.get('oauthClients',r.clientId)!; return c.json({clientName:client.client_name,redirectHost:new URL(r.redirectUri).host || new URL(r.redirectUri).protocol,scope:r.scope}); });
  app.post('/api/oauth/requests/:id/approve',async c=>{
    const a=c.get('actor');requireSession(a);const r=request(c.req.param('id'));
    const v=await body(c,z.object({access:z.enum(['read','write']),workspaceId:z.string().optional()}));
    if(r.scope==='read'&&v.access==='write')fail(400,'Access cannot exceed the requested scope.');
    if(v.workspaceId)membership(s,a,v.workspaceId);
    const code=secret();s.put('oauthCodes',{id:hashSecret(code),userId:a.user.id,clientId:r.clientId,redirectUri:r.redirectUri,challenge:r.challenge,access:v.access,workspaceId:v.workspaceId??null,expiresAt:expires(60000)});
    s.remove('oauthRequests',r.id);const redirect=new URL(r.redirectUri);redirect.searchParams.set('code',code);redirect.searchParams.set('state',r.state);return c.json({redirect:redirect.href});
  });
  app.post('/api/oauth/requests/:id/deny',c=>{requireSession(c.get('actor'));const r=request(c.req.param('id'));s.remove('oauthRequests',r.id);const u=new URL(r.redirectUri);u.searchParams.set('error','access_denied');u.searchParams.set('state',r.state);return c.json({redirect:u.href});});
  app.post('/oauth/token',async c=>{
    let v: Record<string,unknown>;
    try { v=c.req.header('content-type')?.includes('application/json')?await c.req.json():Object.fromEntries(new URLSearchParams(await c.req.text())); } catch { return c.json({error:'invalid_request'},400); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return c.json({error:'invalid_request'},400);
    const client=s.get('oauthClients',String(v.client_id??''));if(!client)return c.json({error:'invalid_client'},400);
    let grant:any;
    if(v.grant_type==='authorization_code') {
      const code=s.get('oauthCodes',hashSecret(String(v.code??'')));
      if(!code||code.expiresAt<=now()||code.clientId!==client.id||code.redirectUri!==v.redirect_uri)return c.json({error:'invalid_grant'},400);
      s.remove('oauthCodes',code.id);
      const verifier=String(v.code_verifier??'');
      if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)||createHash('sha256').update(verifier).digest('base64url')!==code.challenge)return c.json({error:'invalid_grant'},400);
      grant={id:id(),userId:code.userId,clientId:code.clientId,access:code.access,workspaceId:code.workspaceId,createdAt:now(),lastUsedAt:null};
    } else if(v.grant_type==='refresh_token') {
      grant=s.all('oauthGrants').find(g=>g.refreshHash===hashSecret(String(v.refresh_token??''))&&g.refreshExpiresAt>now()&&g.clientId===client.id);
      if(!grant)return c.json({error:'invalid_grant'},400);
    } else return c.json({error:'unsupported_grant_type'},400);
    const user=s.get('users',grant.userId);if(!user||user.disabled)return c.json({error:'invalid_grant'},400);
    const access=secret(),refresh=secret();Object.assign(grant,{accessHash:hashSecret(access),refreshHash:hashSecret(refresh),accessExpiresAt:expires(3600000),refreshExpiresAt:expires(60*86400000)});s.put('oauthGrants',grant);
    c.header('Cache-Control','no-store');return c.json({access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:grant.access});
  });
  app.get('/api/connected-apps',c=>c.json(s.all('oauthGrants').filter(g=>g.userId===c.get('actor').user.id&&g.refreshExpiresAt>now()).map(g=>({id:g.id,clientName:s.get('oauthClients',g.clientId)?.client_name??'Application',access:g.access,createdAt:g.createdAt,lastUsedAt:g.lastUsedAt}))));
  app.delete('/api/connected-apps/:id',c=>{const g=s.get('oauthGrants',c.req.param('id'));if(!g||g.userId!==c.get('actor').user.id)fail(404,'Application not found.');s.remove('oauthGrants',g.id);return c.json({ok:true});});
}
