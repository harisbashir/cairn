import type { Hono } from 'hono';
import { z } from 'zod';
import type { Store } from './db.ts';
import { body, fail, publicUser, type Env } from './common.ts';
import { text, email, password, settings, members, newUser, storageSize } from './account-helpers.ts';
import { passwordFields } from './auth.ts';

export function registerAdmin(app:Hono<Env>,s:Store,deleteWorkspace:(wid:string)=>void) {
  app.use('/api/admin/*',async(c,next)=>{
    if(!c.get('actor').user.isAdmin)fail(403,'Instance administrator access is required.');
    await next();
  });
  app.get('/api/admin/settings',c=>c.json(settings(s)));
  app.patch('/api/admin/settings',async c=>{
    const v=await body(c,z.object({
      instanceName:text.optional(),allowSignup:z.boolean().optional()
    }));
    const st={
      ...settings(s),...v
    };
    s.db.prepare('UPDATE settings SET instanceName=?,allowSignup=? WHERE id=1').run(st.instanceName,+st.allowSignup);
    return c.json(st);
  });
  app.get('/api/admin/overview',c=>{
    const pages=s.all('pages');
    return c.json({
      users:s.all('users').length,workspaces:s.all('workspaces').length,pages:pages.filter(p=>p.kind==='page').length,databases:pages.filter(p=>p.kind==='database').length,rows:pages.filter(p=>p.kind==='row').length,aiEdits7d:s.all('activity').filter(a=>a.actorType==='ai'&&a.at>new Date(Date.now()-7*86400000).toISOString()).length,storageBytes:storageSize(s.dataDir)
    });
  });
  app.get('/api/admin/users',c=>c.json(s.all('users').map(u=>({
    ...publicUser(u),workspaces:s.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE userId=?').get(u.id)!.n
  }))));
  app.post('/api/admin/users',async c=>{
    const v=await body(c,z.object({
      email,name:text,password,isAdmin:z.boolean().optional()
    }));
    return c.json(publicUser(newUser(s,v)));
  });
  app.patch('/api/admin/users/:id',async c=>{
    const uid=c.req.param('id'),a=c.get('actor'),u=s.get('users',uid)??fail(404,'User not found.');
    const v=await body(c,z.object({
      name:text.optional(),isAdmin:z.boolean().optional(),disabled:z.boolean().optional(),password:password.optional()
    }));
    if(uid===a.user.id&&(v.disabled===true||v.isAdmin===false))fail(409,'You cannot disable or demote yourself.');
    if(u.isAdmin&&v.isAdmin===false&&s.all('users').filter(u=>u.isAdmin&&!u.disabled).length<=1)fail(409,'The instance must keep at least one administrator.');
    const {
      password:pw,...fields
    }=v;
    Object.assign(u,fields);
    if(pw)Object.assign(u,passwordFields(pw));
    s.put('users',u);
    return c.json(publicUser(u));
  });
  app.delete('/api/admin/users/:id',c=>{
    const uid=c.req.param('id'),u=s.get('users',uid)??fail(404,'User not found.');
    if(u.isAdmin&&s.all('users').filter(u=>u.isAdmin&&!u.disabled).length<=1)fail(409,'The instance must keep at least one administrator.');
    const owned=s.db.prepare("SELECT workspaceId FROM memberships WHERE userId=? AND role='owner'").all(uid);
    for(const w of owned){
      const ms=members(s,String(w.workspaceId));
      if(ms.filter(m=>m.role==='owner').length===1&&ms.length>1)fail(409,'Transfer workspace ownership before deleting this user.');
    }
    for(const w of owned)if(members(s,String(w.workspaceId)).length===1)deleteWorkspace(String(w.workspaceId));
    for(const t of s.all('tokens').filter(t=>t.userId===uid))s.remove('tokens',t.id);
    for(const table of ['feeds','oauthGrants','oauthCodes','notifications','pushSubscriptions'] as const)for(const value of s.all(table).filter(v=>v.userId===uid))s.remove(table,value.id);
    for(const value of s.all('layouts').filter(v=>v.id.endsWith(':'+uid)))s.remove('layouts',value.id);
    s.remove('users',uid);
    return c.json({
      ok:true
    });
  });
  app.get('/api/admin/workspaces',c=>c.json(s.all('workspaces').map(w=>{
    const ms=members(s,w.id);
    return{
      id:w.id,name:w.name,icon:w.icon,color:w.color,members:ms.length,pages:s.all('pages').filter(p=>p.workspaceId===w.id).length,ownerName:s.get('users',ms.find(m=>m.role==='owner')?.userId)?.name??'',createdAt:w.createdAt
    };
  })));
  app.delete('/api/admin/workspaces/:wid',c=>{
    const wid=c.req.param('wid');
    if(!s.get('workspaces',wid))fail(404,'Workspace not found.');
    deleteWorkspace(wid);
    return c.json({
      ok:true
    });
  });
}
