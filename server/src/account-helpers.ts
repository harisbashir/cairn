import { z } from 'zod';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Role } from '../../shared/types.ts';
import { Store, id, now } from './db.ts';
import { fail, publicUser, type Actor } from './common.ts';
import { passwordFields } from './auth.ts';

export const text = z.string().trim().min(1).max(1000);
export const email = z.email().transform(v=>v.toLowerCase());
export const password = z.string().min(8).max(1024);
export const role = z.enum(['owner','admin','member','viewer']);
export const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour.');
export const workspaceInput = z.object({
  name:text, icon:z.string().max(100).optional(), color:color.optional()
});
export const cleanToken = (t:any) => {
  const {
    hash,userId,...v
  }=t;
  return v;
};
export const cleanInvite = (i:any) => {
  const {
    workspaceId,inviterId,...v
  }=i;
  return v;
};
export function settings(s:Store) {
  const row=s.db.prepare('SELECT * FROM settings WHERE id=1').get()!;
  return {
    instanceName:String(row.instanceName),allowSignup:!!row.allowSignup
  };
}
export function members(s:Store,wid:string):any[] {
  return s.db.prepare('SELECT * FROM memberships WHERE workspaceId=?').all(wid);
}
export function summary(s:Store,wid:string,uid:string) {
  const w=s.get('workspaces',wid) ?? fail(404,'Workspace not found.');
  const m=s.db.prepare('SELECT role FROM memberships WHERE workspaceId=? AND userId=?').get(wid,uid) ?? fail(403,'You are not a member of this workspace.');
  return {
    id:w.id,name:w.name,icon:w.icon,color:w.color,role:m.role
  };
}
export function member(s:Store,wid:string,uid:string) {
  const m=members(s,wid).find(m=>m.userId===uid) ?? fail(404,'Member not found.');
  const u=s.get('users',uid) ?? fail(404,'User not found.');
  return {
    userId:u.id,email:u.email,name:u.name,color:u.color,role:m.role,joinedAt:m.joinedAt
  };
}
export function bootstrap(s:Store,a?:Actor) {
  const st=settings(s);
  return {
    user:a?.user ?? null,instance:{
      name:st.instanceName,allowSignup:st.allowSignup,needsSetup:s.all('users').length===0,version:'0.3.1'
    },workspaces:a?s.db.prepare('SELECT workspaceId FROM memberships WHERE userId=?').all(a.user.id).filter(m=>!a.workspaceId||a.workspaceId===m.workspaceId).map(m=>summary(s,String(m.workspaceId),a.user.id)):[]
  };
}
export function invite(s:Store,token:string) {
  return s.all('invites').find(i=>i.token===token && !i.acceptedAt && i.expiresAt>now() && s.get('workspaces',i.workspaceId)) ?? fail(404,'This invitation has expired or is no longer available.');
}
export function newUser(s:Store,input:{
  email:string;
  name:string;
  password:string;
  isAdmin?:boolean
}) {
  if(s.all('users').some(u=>u.email===input.email)) fail(409,'An account with this email already exists.');
  const u={
    prefs:{theme:'system' as const,accent:'blue' as const,timezone:'UTC',reminderHour:9,notify:{push:true,email:false,mentions:true,comments:true,assigned:true},capture:null},id:id(),email:input.email,name:input.name,color:'#6366f1',isAdmin:input.isAdmin??false,disabled:false,createdAt:now(),lastSeenAt:null,...passwordFields(input.password)
  };
  s.put('users',u);
  return u;
}
export function ownerChange(s:Store,wid:string,target:any,caller:any,newRole:Role|null) {
  if((target.role==='owner' || newRole==='owner') && caller.role!=='owner') fail(403,'Only an owner can change owners.');
  if(target.role==='owner' && newRole!=='owner' && members(s,wid).filter(m=>m.role==='owner').length<=1) fail(409,'A workspace must keep at least one owner.');
}
export function storageSize(path:string):number {
  return readdirSync(path,{
    withFileTypes:true
  }).reduce((n,e)=>n+(e.isDirectory()?storageSize(join(path,e.name)):statSync(join(path,e.name)).size),0);
}
