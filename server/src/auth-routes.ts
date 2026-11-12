import type { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { Store, id, now } from './db.ts';
import { body, fail, membership, publicUser, type Actor, type Env } from './common.ts';
import { text, email, password, color, cleanToken, settings, bootstrap, invite, newUser } from './account-helpers.ts';
import { createSession, destroySession, hashSecret, passwordFields, passwordMatches, sessionActor } from './auth.ts';
import { createWorkspace, acceptInvite } from './workspaces.ts';

export function registerAuthRoutes(app:Hono<Env>,s:Store,seed:(wid:string,actor:Actor,title:string)=>void,emitMembers:(wid:string)=>void) {
  const failures = new Map<string,number[]>();
  app.get('/api/bootstrap',c=>c.json(bootstrap(s,sessionActor(s,c))));
  app.post('/api/auth/signup',async c=>{
    const v=await body(c,z.object({
      email,name:text,password,inviteToken:text.optional()
    }));
    const first=s.all('users').length===0;
    const inv=v.inviteToken?invite(s,v.inviteToken):undefined;
    if(!first&&!settings(s).allowSignup&&!inv) fail(403,'Sign-up is disabled. Ask a workspace administrator for an invitation.');
    if(inv?.email && inv.email!==v.email) fail(403,'This invitation is for another email address.');
    const u=s.transaction(()=>{
      const u=newUser(s,{
        ...v,isAdmin:first
      });
      const a:Actor={
        user:publicUser(u),actorType:'user',clientId:c.req.header('X-Cairn-Client')??null
      };
      if(inv) acceptInvite(s,inv,a,emitMembers);
      if(!inv || first) createWorkspace(s,a,{
        name:`${u.name}'s workspace`
      },seed,'Welcome');
      return u;
    });
    createSession(s,c,u.id);
    return c.json(bootstrap(s,{
      user:publicUser(u),actorType:'user',clientId:null
    }));
  });
  app.post('/api/auth/login',async c=>{
    const v=await body(c,z.object({
      email,password:z.string().max(1024)
    }));
    const times=(failures.get(v.email)??[]).filter(t=>t>Date.now()-15*60000);
    failures.set(v.email,times);
    if(times.length>=10) fail(403,'Too many failed login attempts. Please try again in 15 minutes.');
    const u=s.all('users').find(u=>u.email===v.email);
    if(!u || u.disabled || !passwordMatches(u,v.password)) {
      times.push(Date.now());
      fail(401,'Email or password is incorrect.');
    }
    failures.delete(v.email);
    u.lastSeenAt=now();
    s.put('users',u);
    createSession(s,c,u.id);
    return c.json(bootstrap(s,{
      user:publicUser(u),actorType:'user',clientId:null
    }));
  });
  app.post('/api/auth/logout',c=>{
    destroySession(s,c);
    return c.json({
      ok:true
    });
  });
  app.patch('/api/me',async c=>{
    const v=await body(c,z.object({
      name:text.optional(),color:color.optional(),currentPassword:z.string().max(1024).optional(),newPassword:password.optional()
    }));
    const u=s.get('users',c.get('actor').user.id)!;
    if(v.newPassword) {
      if(!v.currentPassword||!passwordMatches(u,v.currentPassword)) fail(403,'Your current password is incorrect.');
      Object.assign(u,passwordFields(v.newPassword));
    }
    if(v.name!==undefined)u.name=v.name;
    if(v.color!==undefined)u.color=v.color;
    s.put('users',u);
    return c.json(publicUser(u));
  });
  app.get('/api/tokens',c=>c.json(s.all('tokens').filter(t=>t.userId===c.get('actor').user.id).map(cleanToken)));
  app.post('/api/tokens',async c=>{
    const v=await body(c,z.object({
      name:text,access:z.enum(['read','write']),workspaceId:text.optional()
    }));
    const a=c.get('actor');
    if(v.workspaceId)membership(s,a,v.workspaceId);
    const secret='cairn_'+randomBytes(30).toString('base64url');
    const t={
      id:id(),name:v.name,prefix:secret.slice(0,12),access:v.access,workspaceId:v.workspaceId??null,createdAt:now(),lastUsedAt:null,userId:a.user.id,hash:hashSecret(secret)
    };
    s.put('tokens',t);
    return c.json({
      token:cleanToken(t),secret
    });
  });
  app.delete('/api/tokens/:id',c=>{
    const t=s.get('tokens',c.req.param('id'));
    if(!t||t.userId!==c.get('actor').user.id)fail(404,'Token not found.');
    s.remove('tokens',t.id);
    return c.json({
      ok:true
    });
  });
}
