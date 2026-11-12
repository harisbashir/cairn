import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { id, now, type Store } from './db.ts';
import { fail, membership, type Actor } from './common.ts';
export function checkStorage(s:Store,wid:string,bytes:number) {
  if(bytes>20*1024*1024)fail(400,'Files must be at most 20 MB.');
  const max=Number(process.env.CAIRN_MAX_STORAGE_MB??0)*1024*1024;
  if(max>0&&s.all('files').filter(f=>f.workspaceId===wid).reduce((n,f)=>n+(f.size??legacySize(s,f.id)),0)+bytes>max)fail(400,'Workspace storage limit exceeded.');
}
export async function storeFile(s:Store,a:Actor,wid:string,bytes:Uint8Array,filename:string,mime:string) {
  membership(s,a,wid,true);checkStorage(s,wid,bytes.length);
  const key=id(),name=basename(filename).replace(/[\x00-\x1f\x7f]/g,'')||'file';
  // Reserve metadata before I/O so concurrent uploads count towards the quota.
  const file={id:key,workspaceId:wid,name,mime,type:mime,size:bytes.length,createdAt:now(),createdBy:a.user.id,createdByName:a.user.name};s.put('files',file);
  try{await writeFile(join(s.dataDir,'files',key),bytes);}catch(error){s.remove('files',key);throw error;}
  return {...file,url:`/files/${key}/${encodeURIComponent(name)}`};
}

function legacySize(s:Store,key:string):number { try{return statSync(join(s.dataDir,'files',key)).size;}catch{return 0;} }
