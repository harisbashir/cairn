import type { Hono } from 'hono';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename, extname } from 'node:path';
import { id } from './db.ts';
import { type Env, fail, membership } from './common.ts';
import { sessionActor } from './auth.ts';
import { Pages, publicPage } from './pages.ts';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
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
    const key = id();
    const name = basename(file.name).replace(/[\x00-\x1f]/g, '') || 'file';
    await writeFile(join(s.dataDir, 'files', key), Buffer.from(await file.arrayBuffer()));
    s.put('files', { id: key, workspaceId: wid, name, type: file.type });
    return c.json({ url: `/files/${key}/${encodeURIComponent(name)}` });
  });

  app.get('/files/:id/:name', async c => {
    const file = s.get('files', c.req.param('id'));
    if (!file || c.req.param('name') !== file.name) return fail(404, 'File not found.');
    const token = c.req.query('share');
    if (token) {
      const page = publicPage(pages, token);
      if (page.workspaceId !== file.workspaceId) fail(404, 'File not found.');
    } else {
      const actor = sessionActor(s, c) ?? fail(401, 'Please sign in to view this file.');
      membership(s, actor, file.workspaceId);
    }
    let bytes: Buffer;
    try { bytes = await readFile(join(s.dataDir, 'files', file.id)); }
    catch { return fail(404, 'File not found.'); }
    c.header('Content-Type', file.type || 'application/octet-stream');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
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
    c.header('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    return c.body(new Uint8Array(bytes));
  });
}
