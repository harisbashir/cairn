import { type Store, now } from './db.ts';
import type { Pages } from './pages.ts';
/** Internal retention work runs independently of any caller's permissions. */
export function purgeExpired(s:Store,pages:Pages) {
  const time=now(),cutoff=new Date(Date.now()-30*86400000).toISOString();
  s.transaction(()=>{
    s.db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(time);
    for(const table of ['invites','oauthCodes','oauthRequests'] as const)for(const value of s.all(table))if(value.expiresAt<=time)s.remove(table,value.id);
    for(const grant of s.all('oauthGrants'))if(grant.refreshExpiresAt<=time)s.remove('oauthGrants',grant.id);
    const retention=new Date(Date.now()-90*86400000).toISOString();
    for(const table of ['changes','notifications'] as const)for(const value of s.all(table))if(value.at<retention)s.remove(table,value.id);
    const all=s.all('pages');
    const removed=new Set(all.filter(p=>[...pages.ancestors(p),p].some(a=>a.deletedAt&&a.deletedAt<cutoff)).map(p=>p.id));
    for(const key of removed){s.db.prepare('DELETE FROM links WHERE fromId=? OR toId=?').run(key,key);for(const c of s.all('comments').filter(c=>c.pageId===key))s.remove('comments',c.id);s.remove('pages',key);s.db.prepare('DELETE FROM search WHERE id=?').run(key);}
    for(const v of s.all('versions'))if(removed.has(v.pageId))s.remove('versions',v.id);
  });
}
export function startHousekeeping(s:Store,pages:Pages) {
  purgeExpired(s,pages);
  const timer=setInterval(()=>{try{purgeExpired(s,pages);}catch{/* Retry at the next daily interval. */}},86400000);timer.unref();return ()=>clearInterval(timer);
}
