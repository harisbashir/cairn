import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';

let app:ReturnType<typeof createApp>,dir:string,cookie:string;
async function req(method:string,path:string,data?:unknown,auth=cookie) {
  return app.request(path,{method,headers:{'Content-Type':'application/json','X-Cairn-Client':'accounts-test',...(auth?{Cookie:auth}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
}
async function signup(email='owner@example.com',inviteToken?:string) {
  const r=await req('POST','/api/auth/signup',{email,name:email.split('@')[0],password:'password123',...(inviteToken?{inviteToken}:{})},'');
  const result=await r.json();
  return {r,result,cookie:r.headers.get('set-cookie')?.split(';')[0]??''};
}
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'cairn-accounts-'));app=createApp({dataDir:dir});cookie='';});
afterEach(()=>{rmSync(dir,{recursive:true,force:true});});
describe('accounts and workspace administration',()=>{
  it('bootstraps the first administrator, authenticates, and revokes logout sessions',async()=>{
    expect((await (await req('GET','/api/bootstrap')).json()).instance.needsSetup).toBe(true);
    const first=await signup();cookie=first.cookie;
    expect(first.r.status).toBe(200);expect(first.result.user.isAdmin).toBe(true);expect(first.result.workspaces[0].role).toBe('owner');
    expect(Object.keys(first.result.user).sort()).toEqual(['id','email','name','color','isAdmin','disabled','createdAt','lastSeenAt'].sort());
    expect((await req('POST','/api/auth/signup',{email:'blocked@example.com',name:'Blocked',password:'password123'},'')).status).toBe(403);
    expect((await req('POST','/api/auth/logout')).status).toBe(200);
    expect((await (await req('GET','/api/bootstrap')).json()).user).toBeNull();
    const wrong=await req('POST','/api/auth/login',{email:'owner@example.com',password:'incorrect'},'');
    const missing=await req('POST','/api/auth/login',{email:'missing@example.com',password:'incorrect'},'');
    expect(await wrong.json()).toEqual(await missing.json());
    const login=await req('POST','/api/auth/login',{email:'owner@example.com',password:'password123'},'');expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  });
  it('accepts email-bound invites, enforces roles and keeps an owner',async()=>{
    const first=await signup();cookie=first.cookie;const wid=first.result.workspaces[0].id;
    const i=await (await req('POST',`/api/workspaces/${wid}/invites`,{email:'viewer@example.com',role:'viewer'})).json();
    expect((await req('GET',`/api/invites/${i.token}`,undefined,'')).status).toBe(200);
    const second=await signup('viewer@example.com',i.token);expect(second.r.status).toBe(200);expect(second.result.workspaces).toHaveLength(1);
    expect((await req('GET',`/api/invites/${i.token}`,undefined,'')).status).toBe(404);
    expect((await req('PATCH',`/api/workspaces/${wid}`,{name:'Denied'},second.cookie)).status).toBe(403);
    expect((await req('GET','/api/admin/users',undefined,second.cookie)).status).toBe(403);
    expect((await req('PATCH',`/api/workspaces/${wid}/members/${first.result.user.id}`,{role:'member'})).status).toBe(409);
    const promoted=await req('PATCH',`/api/workspaces/${wid}/members/${second.result.user.id}`,{role:'admin'});expect((await promoted.json()).role).toBe('admin');
    expect((await req('DELETE',`/api/workspaces/${wid}/members/${first.result.user.id}`,undefined,second.cookie)).status).toBe(403);
    expect((await req('DELETE',`/api/workspaces/${wid}/members/${second.result.user.id}`,undefined,second.cookie)).status).toBe(200);
  });
  it('manages users, settings, tokens and disabled credentials',async()=>{
    const first=await signup();cookie=first.cookie;
    expect((await req('PATCH','/api/admin/settings',{instanceName:'Notes',allowSignup:true})).status).toBe(200);
    const second=await signup('second@example.com');expect(second.r.status).toBe(200);
    const created=await req('POST','/api/tokens',{name:'Agent',access:'read',workspaceId:first.result.workspaces[0].id});
    const t=await created.json();expect(t.secret).toMatch(/^cairn_[A-Za-z0-9_-]{40}$/);expect(t.token).not.toHaveProperty('hash');
    expect((await (await req('GET','/api/tokens')).json())[0].id).toBe(t.token.id);
    expect((await req('DELETE',`/api/tokens/${t.token.id}`,undefined,second.cookie)).status).toBe(404);
    expect((await req('DELETE',`/api/tokens/${t.token.id}`)).status).toBe(200);
    expect((await req('PATCH',`/api/admin/users/${first.result.user.id}`,{disabled:true})).status).toBe(409);
    expect((await req('PATCH',`/api/admin/users/${second.result.user.id}`,{disabled:true})).status).toBe(200);
    expect((await req('GET','/api/tokens',undefined,second.cookie)).status).toBe(401);
    expect((await req('POST','/api/auth/login',{email:'second@example.com',password:'password123'},'')).status).toBe(401);
    expect((await req('GET','/api/admin/overview')).status).toBe(200);
    expect((await req('GET','/api/admin/workspaces')).status).toBe(200);
    expect((await req('DELETE',`/api/admin/users/${second.result.user.id}`)).status).toBe(200);
  });
  it('requires client headers and changes passwords only with the current password',async()=>{
    const first=await signup();cookie=first.cookie;
    expect((await app.request('/api/me',{method:'PATCH',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'No'})})).status).toBe(400);
    expect((await req('PATCH','/api/me',{newPassword:'newpassword',currentPassword:'wrong'})).status).toBe(403);
    expect((await req('PATCH','/api/me',{newPassword:'newpassword',currentPassword:'password123'})).status).toBe(200);
    expect((await req('POST','/api/auth/login',{email:'owner@example.com',password:'newpassword'},'')).status).toBe(200);
  });
  it('prevents admin self-promotion and enforces invitation emails',async()=>{
    const first=await signup();cookie=first.cookie;const wid=first.result.workspaces[0].id;
    const invitation=await (await req('POST',`/api/workspaces/${wid}/invites`,{email:'admin@example.com',role:'admin'})).json();
    const wrong=await signup('wrong@example.com',invitation.token);expect(wrong.r.status).toBe(403);
    const admin=await signup('admin@example.com',invitation.token);expect(admin.r.status).toBe(200);
    expect((await req('PATCH',`/api/workspaces/${wid}/members/${admin.result.user.id}`,{role:'owner'},admin.cookie)).status).toBe(403);
    expect((await req('PATCH',`/api/workspaces/${wid}/members/${first.result.user.id}`,{role:'member'},admin.cookie)).status).toBe(403);
    expect((await req('POST',`/api/workspaces/${wid}/invites`,{role:'owner'},admin.cookie)).status).toBe(403);
    const bound=await (await req('POST',`/api/workspaces/${wid}/invites`,{email:'other@example.com',role:'member'})).json();
    expect((await req('POST',`/api/invites/${bound.token}/accept`,undefined,admin.cookie)).status).toBe(403);
    expect((await req('PATCH',`/api/workspaces/${wid}/members/${admin.result.user.id}`,{role:'owner'})).status).toBe(200);
    expect((await req('DELETE',`/api/workspaces/${wid}/members/${first.result.user.id}`)).status).toBe(200);
  });
  it('limits repeated login failures for each normalized email',async()=>{
    const first=await signup();cookie=first.cookie;
    for(let i=0;i<10;i++) expect((await req('POST','/api/auth/login',{email:'OWNER@example.com',password:'wrong'},'')).status).toBe(401);
    const limited=await req('POST','/api/auth/login',{email:'owner@example.com',password:'password123'},'');
    expect(limited.status).toBe(403);expect((await limited.json()).error.message).toContain('15 minutes');
    expect((await req('POST','/api/auth/login',{email:'unrelated@example.com',password:'wrong'},'')).status).toBe(401);
  });

});
