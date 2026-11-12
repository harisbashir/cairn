import type { Hono } from 'hono';
import { z } from 'zod';
import { Store, id, now } from './db.ts';
import { body, fail, membership, publicUrl, type Actor, type Env } from './common.ts';
import { email, role, workspaceInput, cleanInvite, members, summary, member, invite, ownerChange } from './account-helpers.ts';

export function createWorkspace(s:Store,a:Actor,v:{
  name:string;
  icon?:string;
  color?:string
},seed:(wid:string,actor:Actor,title:string)=>void,welcome='Getting started') {
  const w={
    id:id(),name:v.name,icon:v.icon??'',color:v.color??'#6366f1',createdAt:now()
  };
  s.put('workspaces',w);
  s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(w.id,a.user.id,'owner',now());
  seed(w.id,a,welcome);
  return summary(s,w.id,a.user.id);
}
export function acceptInvite(s:Store,i:any,a:Actor,emitMembers:(wid:string)=>void) {
  if(i.email && i.email!==a.user.email) fail(403,'This invitation is for another email address.');
  if(!members(s,i.workspaceId).some(m=>m.userId===a.user.id)) s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(i.workspaceId,a.user.id,i.role,now());
  i.acceptedAt=now();
  s.put('invites',i);
  emitMembers(i.workspaceId);
  s.put('activity',{
    id:id(),workspaceId:i.workspaceId,actorId:a.user.id,at:now(),actorName:a.user.name,actorType:a.actorType,action:'joined',pageId:null,pageTitle:'',pageIcon:''
  });
  return summary(s,i.workspaceId,a.user.id);
}
export function registerWorkspaces(app:Hono<Env>,s:Store,seed:(wid:string,actor:Actor,title:string)=>void,deleteWorkspace:(wid:string)=>void,emitMembers:(wid:string)=>void) {
  app.post('/api/workspaces',async c=>c.json(createWorkspace(s,c.get('actor'),await body(c,workspaceInput),seed)));
  app.patch('/api/workspaces/:wid',async c=>{
    const wid=c.req.param('wid');
    membership(s,c.get('actor'),wid,true,true);
    const v=await body(c,workspaceInput.partial());
    const w=s.get('workspaces',wid)!;
    Object.assign(w,v);
    s.put('workspaces',w);
    return c.json(summary(s,wid,c.get('actor').user.id));
  });
  app.delete('/api/workspaces/:wid',c=>{
    const wid=c.req.param('wid');
    const m=membership(s,c.get('actor'),wid,true,true);
    if(m.role!=='owner')fail(403,'Only an owner can delete a workspace.');
    deleteWorkspace(wid);
    return c.json({
      ok:true
    });
  });
  app.get('/api/workspaces/:wid/members',c=>{
    const wid=c.req.param('wid');
    membership(s,c.get('actor'),wid);
    return c.json(members(s,wid).map(m=>member(s,wid,m.userId)));
  });
  app.get('/api/workspaces/:wid/users',c=>{
    const wid=c.req.param('wid');
    membership(s,c.get('actor'),wid);
    return c.json(members(s,wid).map(m=>{
      const u=s.get('users',m.userId)!;
      return{
        id:u.id,name:u.name,color:u.color
      };
    }));
  });
  app.patch('/api/workspaces/:wid/members/:userId',async c=>{
    const wid=c.req.param('wid'),uid=c.req.param('userId'),a=c.get('actor');
    const caller=membership(s,a,wid,true,true);
    const v=await body(c,z.object({
      role
    }));
    const target=member(s,wid,uid);
    ownerChange(s,wid,target,caller,v.role);
    s.db.prepare('UPDATE memberships SET role=? WHERE workspaceId=? AND userId=?').run(v.role,wid,uid);
    emitMembers(wid);
    return c.json(member(s,wid,uid));
  });
  app.delete('/api/workspaces/:wid/members/:userId',c=>{
    const wid=c.req.param('wid'),uid=c.req.param('userId'),a=c.get('actor');
    const caller=membership(s,a,wid);
    const target=member(s,wid,uid);
    if(uid!==a.user.id)membership(s,a,wid,true,true);
    ownerChange(s,wid,target,caller,null);
    s.db.prepare('DELETE FROM memberships WHERE workspaceId=? AND userId=?').run(wid,uid);
    emitMembers(wid);
    return c.json({
      ok:true
    });
  });
  app.get('/api/workspaces/:wid/invites',c=>{
    const wid=c.req.param('wid');
    membership(s,c.get('actor'),wid,false,true);
    return c.json(s.all('invites').filter(i=>i.workspaceId===wid&&!i.acceptedAt&&i.expiresAt>now()).map(cleanInvite));
  });
  app.post('/api/workspaces/:wid/invites',async c=>{
    const wid=c.req.param('wid'),a=c.get('actor'),m=membership(s,a,wid,true,true);
    const v=await body(c,z.object({
      email:email.optional(),role
    }));
    if(v.role==='owner'&&m.role!=='owner')fail(403,'Only an owner can invite another owner.');
    const i={
      id:id(),token:id(),email:v.email??null,role:v.role,createdAt:now(),expiresAt:new Date(Date.now()+14*86400000).toISOString(),acceptedAt:null,workspaceId:wid,inviterId:a.user.id
    };
    s.put('invites',i);
    c.header('Link', `<${publicUrl(c, '/invite/' + i.token)}>; rel="canonical"`);
    emitMembers(wid);
    return c.json(cleanInvite(i));
  });
  app.delete('/api/workspaces/:wid/invites/:id',c=>{
    const wid=c.req.param('wid');
    membership(s,c.get('actor'),wid,true,true);
    const i=s.get('invites',c.req.param('id'));
    if(!i||i.workspaceId!==wid)fail(404,'Invitation not found.');
    s.remove('invites',i.id);
    emitMembers(wid);
    return c.json({
      ok:true
    });
  });
  app.get('/api/invites/:token',c=>{
    const i=invite(s,c.req.param('token')),w=s.get('workspaces',i.workspaceId)!;
    c.header('Link', `<${publicUrl(c, '/invite/' + i.token)}>; rel="canonical"`);
    return c.json({
      workspaceName:w.name,workspaceIcon:w.icon,inviterName:s.get('users',i.inviterId)?.name??'Former member',role:i.role,email:i.email
    });
  });
  app.post('/api/invites/:token/accept',c=>c.json(acceptInvite(s,invite(s,c.req.param('token')),c.get('actor'),emitMembers)));
}
