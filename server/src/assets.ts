import type { Hono } from 'hono';
import { readFile, unlink, stat } from 'node:fs/promises';
import { resolve, join, basename, extname } from 'node:path';
import { id } from './db.ts';
import { type Env, fail, membership } from './common.ts';
import { credentialActor } from './credentials.ts';
import { storeFile } from './file-storage.ts';
import { Pages, publicPage } from './pages.ts';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export function registerAssets(app: Hono<Env>, pages: Pages) {
  const s = pages.s;
  app.post('/api/workspaces/:wid/files', async c => {
    const wid = c.req.param('wid');
    membership(s, c.get('actor'), wid, true);
    if (Number(c.req.header('content-length') ?? 0) > 21 * 1024 * 1024) {
      fail(400, 'Files must be at most 20 MB.');
    }
    let form: FormData;
    try { form = await c.req.formData(); }
    catch { return fail(400, 'A multipart file is required.'); }
    const file = form.get('file');
    if (!file || typeof file === 'string') return fail(400, 'A file is required.');
    if (file.size > 20 * 1024 * 1024) fail(400, 'Files must be at most 20 MB.');
    const stored = await storeFile(s,c.get('actor'),wid,new Uint8Array(await file.arrayBuffer()),file.name,file.type);
    return c.json({url:stored.url});
  });

  app.get('/api/workspaces/:wid/files', async c => {
    const wid=c.req.param('wid'); membership(s,c.get('actor'),wid);
    const files=s.all('files').filter(f=>f.workspaceId===wid).reverse().sort((a,b)=>(b.createdAt??'').localeCompare(a.createdAt??''));
    return c.json(await Promise.all(files.map(async f=>({id:f.id,name:f.name,url:`/files/${f.id}/${encodeURIComponent(f.name)}`,mime:f.mime??f.type??'application/octet-stream',size:f.size??await stat(join(s.dataDir,'files',f.id)).then(x=>x.size).catch(()=>0),createdAt:f.createdAt??'',createdByName:f.createdByName??s.get('users',f.createdBy??'')?.name??'Former member'}))));
  });
  app.delete('/api/files/:id',async c=>{const f=s.get('files',c.req.param('id'))??fail(404,'File not found.');const a=c.get('actor'),m=membership(s,a,f.workspaceId,true);if(f.createdBy!==a.user.id&&!['owner','admin'].includes(m.role))fail(403,'Only the uploader or a workspace administrator can delete this file.');await unlink(join(s.dataDir,'files',f.id)).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});s.remove('files',f.id);return c.json({ok:true});});
  app.get('/files/:id/:name', async c => {
    const file = s.get('files', c.req.param('id'));
    if (!file || c.req.param('name') !== file.name) return fail(404, 'File not found.');
    const token = c.req.query('share');
    if (token) {
      const page = publicPage(pages, token);
      if (page.workspaceId !== file.workspaceId) fail(404, 'File not found.');
    } else {
      const actor = credentialActor(s, c) ?? fail(401, 'Please sign in to view this file.');
      membership(s, actor, file.workspaceId);
    }
    let bytes: Buffer;
    try { bytes = await readFile(join(s.dataDir, 'files', file.id)); }
    catch { return fail(404, 'File not found.'); }
    const type = file.mime || file.type || 'application/octet-stream';
    c.header('Content-Type', type);
    c.header('Cache-Control','private, max-age=31536000, immutable');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', `${(/^(image\/(?!svg\+xml)|audio\/|video\/)/i.test(type) || type === 'application/pdf') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(new Uint8Array(bytes));
  });
}

export function registerStatic(app: Hono<Env>) {
  app.get('*', async c => {
    if (/^\/(api|mcp|files)(\/|$)/.test(c.req.path)) return c.notFound();
    const root = resolve('dist/web');
    let path: string;
    try { path = resolve(root, '.' + decodeURIComponent(c.req.path)); }
    catch { return c.notFound(); }
    if (path !== root && !path.startsWith(root + '/')) return c.notFound();
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch {
      path = join(root, 'index.html');
      try { bytes = await readFile(path); }
      catch { return c.notFound(); }
    }
    if(c.req.path.startsWith('/assets/'))c.header('Cache-Control','public, max-age=31536000, immutable');
    if(['index.html','sw.js','manifest.webmanifest'].includes(basename(path)))c.header('Cache-Control','no-cache');
    c.header('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    return c.body(new Uint8Array(bytes));
  });
}
