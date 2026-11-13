import type { Hono } from 'hono';
import { z } from 'zod';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { readFile } from 'node:fs/promises';
import { basename, extname, posix, join } from 'node:path';
import type { Page, Property, PropValue, Sticky } from '../../shared/types.ts';
import { docToMarkdown, markdownToDoc } from '../../shared/markdown.ts';
import { type Actor, type Env, body, fail, membership } from './common.ts';
import { clean, Pages } from './pages.ts';
import { validateSchema } from './page-fields.ts';
import { pageCreate } from './page-validation.ts';
import { id } from './db.ts';
import { storeFile } from './file-storage.ts';
import { Jobs } from './jobs.ts';
import { Notion } from './notion.ts';
import { Dashboard, stickyInput, widgetsSchema } from './dashboard.ts';

/** Jobs re-check live account and workspace authority after every asynchronous boundary. */
export function assertTransferAccess(pages: Pages, actor: Actor, wid: string, write = true) {
  const user = pages.s.get('users', actor.user.id);
  if (!user || user.disabled) fail(403, 'This account is no longer active.');
  membership(pages.s, actor, wid, write);
}

export function displayValue(pages: Pages, property: Property, value: PropValue | undefined, actor?: Actor): string {
  if (value == null) return '';
  return (Array.isArray(value) ? value : [value]).map(item => {
    if (property.options) return property.options.find(option => option.id === item)?.name ?? '';
    if (property.type === 'relation') { try { return actor ? pages.get(actor, String(item)).title : ''; } catch { return ''; } }
    if (property.type === 'files') { try { return decodeURIComponent(String(item).split('/').at(-1) ?? ''); } catch { return ''; } }
    if (property.type === 'person') return pages.s.get('users', String(item))?.name ?? '';
    return String(item);
  }).join(';');
}
const quote = (value: string) => /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
function markdown(pages: Pages, page: Page, actor: Actor): string {
  const schema = page.kind === 'row' && page.parentId ? pages.s.get<Page>('pages', page.parentId)?.schema ?? [] : [];
  return '---\ntitle: ' + JSON.stringify(page.title) + '\n' + schema.map(property => JSON.stringify(property.name) + ': ' + JSON.stringify(displayValue(pages, property, page.props[property.id], actor)) + '\n').join('') + '---\n\n' + docToMarkdown(page.content) + '\n';
}
function subtree(pages: Pages, actor: Actor, root: Page): Page[] {
  return pages.list(actor, root.workspaceId).filter(page => page.id === root.id || pages.ancestors(page).some(parent => parent.id === root.id)).map(p=>clean(pages.computed(actor,p)));
}
export function exportPage(pages: Pages, actor: Actor, pageId: string, format: string): string {
  const page = pages.computed(actor,pages.get(actor, pageId));
  if (format === 'json') {const visible=subtree(pages,actor,page);const ids=new Set(visible.map(p=>p.id));return JSON.stringify({ version: 1, pages: visible, comments:pages.s.all('comments').filter(c=>ids.has(c.pageId)) }, null, 2);}
  if (format === 'md' && page.kind !== 'database') return markdown(pages, page, actor);
  if (format === 'csv' && page.kind === 'database') return [ ['Name', ...page.schema.map(property => property.name)], ...pages.rows(actor, page.id).map(row => [row.title, ...page.schema.map(property => displayValue(pages, property, row.props[property.id], actor))]) ].map(row => row.map(quote).join(',')).join('\r\n');
  return fail(400, 'Use md for pages, csv for databases, or json.');
}
const safeName = (title: string) => title.replace(/[\\/\x00-\x1f]/g, '_').replace(/^\.+$/, '_') || 'Untitled';
export async function exportWorkspace(pages: Pages, actor: Actor, wid: string): Promise<Uint8Array> {
  const visible = pages.list(actor, wid).map(p=>clean(pages.computed(actor,p)));
  const visibleIds=new Set(visible.map(p=>p.id));
  const comments=pages.s.all('comments').filter(c=>visibleIds.has(c.pageId));
  const stickies = pages.s.all<Sticky>('stickies').filter(note => note.workspaceId === wid && (note.visibility !== 'private' || note.createdBy === actor.user.id));
  const layouts = pages.s.all('layouts').filter(layout => layout.workspaceId === wid && (layout.id === wid || layout.id === wid + ':' + actor.user.id));
  const entries: Record<string, Uint8Array> = {};
  const paths = new Map<string, string>();
  const pathFor = (page: Page): string => {
    if (paths.has(page.id)) return paths.get(page.id)!;
    const parent = visible.find(candidate => candidate.id === page.parentId);
    const prefix = parent ? pathFor(parent) + '/' : '';
    let path = prefix + safeName(page.title);
    if ([...paths.values()].includes(path)) path += ' ' + page.id;
    paths.set(page.id, path); return path;
  };
  for (const page of visible.filter(p=>!pages.isTemplate(p))) {
    const path = pathFor(page);
    entries[path + (page.kind === 'database' ? '.csv' : '.md')] = strToU8(exportPage(pages, actor, page.id, page.kind === 'database' ? 'csv' : 'md'));
  }
  const files = [];
  const serialized = JSON.stringify(visible);
  for (const file of pages.s.all('files').filter(file => file.workspaceId === wid && serialized.includes('/files/' + file.id + '/'))) {
    try { entries['files/' + file.id + '/' + safeName(file.name)] = new Uint8Array(await readFile(join(pages.s.dataDir, 'files', file.id))); files.push(file); }
    catch { /* Missing originals must not make the rest of the workspace unavailable. */ }
  }
  for (const [path, bytes] of Object.entries(entries)) if (path.endsWith('.md')) {
    let text = strFromU8(bytes);
    for (const file of files) text = text.split(`/files/${file.id}/${encodeURIComponent(file.name)}`).join(posix.relative(posix.dirname(path), 'files/' + file.id + '/' + safeName(file.name)));
    entries[path] = strToU8(text);
  }
  entries['cairn.json'] = strToU8(JSON.stringify({ version: 1, pages: visible, stickies, layouts, files, comments }, null, 2));
  return zipSync(entries);
}

/** RFC 4180, including quoted newlines and escaped quotes. */
export function parseCsv(source: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  source = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(cell); cell = '';
      if (c !== ',') { if (c === '\r' && source[i + 1] === '\n') i++; rows.push(row); row = []; }
    } else cell += c;
  }
  if (quoted) fail(400, 'Unterminated quoted CSV field.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
export function inferColumn(name: string, values: string[]): Property {
  const nonempty = values.map(value => value.trim()).filter(Boolean);
  const unique = [...new Set(nonempty)];
  const property: Property = { id: id(), name, type: 'text' };
  if (!nonempty.length) return property;
  if (nonempty.every(value => /^(true|false|yes|no|checked|unchecked)$/i.test(value))) property.type = 'checkbox';
  else if (nonempty.every(value => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value) && Number.isFinite(Number(value)))) property.type = 'number';
  else if (nonempty.every(value => /^\d{4}-\d\d-\d\d(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)))) property.type = 'date';
  else if (nonempty.every(value => /^https?:\/\/\S+$/i.test(value))) property.type = 'url';
  else {
    const tokens = nonempty.flatMap(value => value.split(/[,;]/).map(item => item.trim()).filter(Boolean));
    if (nonempty.some(value => /[,;]/.test(value)) && tokens.length > new Set(tokens).size && [...new Set(tokens)].every(value => value.length <= 80)) {
      property.type = 'multi_select'; property.options = [...new Set(tokens)].map(name => ({ id: id(), name, color: 'gray' }));
    } else if (unique.length <= 12 && unique.every(value => value.length <= 80)) {
      property.type = 'select'; property.options = unique.map(name => ({ id: id(), name, color: 'gray' }));
    }
  }
  return property;
}
function importCsv(pages: Pages, actor: Actor, wid: string, parentId: string | null, title: string, source: string): Page {
  const [header, ...rows] = parseCsv(source);
  if (!header?.length) fail(400, 'CSV requires a header.');
  const schema = header.slice(1).map((name, index) => inferColumn(name, rows.map(row => row[index + 1] ?? '')));
  const database = pages.create(actor, wid, { parentId, title, kind: 'database', schema });
  if (!schema.length) { database.schema = []; pages.change(actor, database, 'updated'); }
  for (const cells of rows.filter(row => row.some(Boolean))) {
    const props: Record<string, PropValue> = {};
    schema.forEach((property, index) => {
      const value = (cells[index + 1] ?? '').trim(); if (!value) return;
      props[property.id] = property.type === 'number' ? Number(value) : property.type === 'checkbox' ? /^(true|yes|checked)$/i.test(value) : property.type === 'multi_select' ? value.split(/[,;]/).map(name => property.options!.find(option => option.name === name.trim())!.id) : property.type === 'select' ? property.options!.find(option => option.name === value)!.id : value;
    });
    pages.create(actor, wid, { parentId: database.id, kind: 'row', title: cells[0] ?? '', props });
  }
  return database;
}
export async function storeImportFile(pages: Pages, actor: Actor, wid: string, name: string, bytes: Uint8Array, mime = 'application/octet-stream'): Promise<string> {
  assertTransferAccess(pages, actor, wid);
  return (await storeFile(pages.s, actor, wid, bytes, name, mime)).url;
}
const imageMime = (name: string) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[extname(name).toLowerCase()] ?? 'application/octet-stream');
function rewrite(value: any, ids: Map<string, string>, urls = new Map<string, string>(), field = ''): any {
  if (typeof value === 'string') { if (ids.has(value) && !['type', 'title', 'name', 'text', 'visibility', 'color', 'createdBy', 'updatedBy', 'createdByName', 'updatedByType'].includes(field)) return ids.get(value); for (const [from, to] of urls) value = value.split(from).join(to); return value.replace(/cairn:\/\/page\/([\w-]+)/g, (_: string, key: string) => 'cairn://page/' + (ids.get(key) ?? key)); }
  if (Array.isArray(value)) return value.map(item => rewrite(item, ids, urls, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [ids.get(key) ?? key, rewrite(item, ids, urls, key)]));
  return value;
}
async function importJson(pages: Pages, actor: Actor, wid: string, parentId: string | null, data: any, entries: Record<string, Uint8Array>): Promise<string[]> {
  assertTransferAccess(pages, actor, wid);
  const notes = z.array(stickyInput.extend({ position: z.number().optional() })).max(100000).parse(data.stickies ?? []);
  const layouts = z.array(z.object({ id: z.string(), workspaceId: z.string(), widgets: widgetsSchema })).max(2).parse(data.layouts ?? []);
  for (const layout of layouts) if (layout.id === layout.workspaceId) membership(pages.s, actor, wid, true, true);
  const source: Page[] = Array.isArray(data) ? data : data.pages ?? (data.kind ? [data] : []);
  if (!source.length || source.length > 100000) fail(400, 'No pages found in Cairn export.');
  for (const page of source) { if (!page.id || !pageCreate.safeParse({ ...page, props: page.kind === 'row' ? page.props : undefined, schema: page.kind === 'database' ? page.schema : undefined, views: page.kind === 'database' ? page.views : undefined }).success) fail(400, 'Invalid page in Cairn export.'); }
  if (new Set(source.map(page => page.id)).size !== source.length) fail(400, 'Duplicate page ids.');
  for (const page of source) {
    const seen = new Set<string>([page.id]); let parent = source.find(candidate => candidate.id === page.parentId);
    if (page.kind === 'row' && parent && parent.kind !== 'database') fail(400, 'Rows require a database parent.');
    while (parent) { if (seen.has(parent.id)) fail(400, 'Cyclic page hierarchy.'); seen.add(parent.id); parent = source.find(candidate => candidate.id === parent!.parentId); }
  }
  const ids = new Map<string, string>();
  for (const page of source) {
    ids.set(page.id, id());
    for (const property of page.schema ?? []) { ids.set(property.id, id()); for (const option of property.options ?? []) ids.set(option.id, id()); }
    for (const view of page.views ?? []) ids.set(view.id, id());
  }
  const urls = new Map<string, string>();
  for (const file of data.files ?? []) {
    const entry = entries['files/' + file.id + '/' + safeName(file.name)];
    if (entry) urls.set(`/files/${file.id}/${encodeURIComponent(file.name)}`, await storeImportFile(pages, actor, wid, file.name, entry, file.mime ?? file.type));
  }
  const pending = [...source], created = new Set<string>(), top: string[] = [];
  while (pending.length) {
    const index = pending.findIndex(page => !source.some(parent => parent.id === page.parentId) || created.has(page.parentId!));
    if (index < 0) fail(400, 'Cyclic page hierarchy.');
    assertTransferAccess(pages, actor, wid);
    const original = pending.splice(index, 1)[0];
    const imported = rewrite(original, ids, urls) as Page;
    const root = !source.some(page => page.id === original.parentId);
    const parent = root ? parentId : imported.parentId;
    if(imported.kind==='row'){const sourceParent=source.find(p=>p.id===original.parentId);const schema=sourceParent?rewrite(sourceParent.schema,ids,urls):pages.s.get<Page>('pages',parent??'')?.schema??[];for(const property of schema)if(['files','rollup','formula'].includes(property.type))delete imported.props[property.id];}
    const input = pageCreate.parse({ ...imported, defaultTemplateId:imported.kind==='database'?imported.defaultTemplateId:undefined, parentId: parent, props: imported.kind === 'row' ? imported.props : undefined, schema: imported.kind === 'database' ? imported.schema.filter(p=>p.type!=='rollup') : undefined, views: imported.kind === 'database' ? imported.views : undefined });
    if (root && input.kind === 'row' && (!parent || pages.get(actor, parent).kind !== 'database')) input.kind = 'page', input.props = undefined;
    const next = pages.create(actor, wid, input);
    // Allocate predetermined ids so forward references remain valid.
    pages.s.remove('pages', next.id); pages.s.db.prepare('DELETE FROM search WHERE id=?').run(next.id);
    next.id = imported.id; next.position = original.position ?? next.position;
    if (original.kind === 'database') { next.views = imported.views; }
    pages.change(actor, next, 'updated');
    next.createdAt = original.createdAt ?? next.createdAt; next.updatedAt = original.updatedAt ?? next.updatedAt;
    pages.s.put('pages', next); created.add(original.id); if (root) top.push(next.id);
  }
  // Resolve computed schemas and default templates after every referenced database/row exists.
  const databases=source.filter(p=>p.kind==='database').map(original=>rewrite(original,ids,urls) as Page);
  const schemas=new Map(databases.map(database=>[database.id,database.schema]));
  for(const database of databases)validateSchema(pages,actor,wid,database.schema,database.id,schemas);
  for(const database of databases){
    const next=pages.get(actor,database.id,true);
    if(database.defaultTemplateId){const template=pages.get(actor,database.defaultTemplateId);if(!template.isTemplate||template.kind!=='row'||template.parentId!==next.id)fail(400,'Invalid imported default template.');}
    next.schema=database.schema;next.defaultTemplateId=database.defaultTemplateId??null;pages.change(actor,next,'updated');
  }
  for(const comment of data.comments??[]){if(!ids.has(comment.pageId)||typeof comment.body!=='string'||comment.body.length>5000)continue;if(!ids.has(comment.id))ids.set(comment.id,id());if(!ids.has(comment.threadId))ids.set(comment.threadId,id());}
  for(const comment of data.comments??[]){if(!ids.has(comment.id)||!ids.has(comment.pageId))continue;const key=ids.get(comment.id)!;pages.s.put('comments',{id:key,pageId:ids.get(comment.pageId)!,threadId:ids.get(comment.threadId)!,quote:typeof comment.quote==='string'?comment.quote:'',body:comment.body,resolved:!!comment.resolved,createdBy:actor.user.id,createdByName:actor.user.name,createdByType:actor.actorType,createdAt:comment.createdAt??new Date().toISOString(),updatedAt:comment.updatedAt??new Date().toISOString()});}
  const dashboard = new Dashboard(pages);
  for (const note of notes) { assertTransferAccess(pages, actor, wid); const imported = dashboard.add(actor, wid, note); if (note.position !== undefined) { imported.position = note.position; pages.s.put('stickies', imported); } }
  for (const layout of layouts) { assertTransferAccess(pages, actor, wid); dashboard.setHome(actor, wid, rewrite(layout.widgets, ids, urls), layout.id !== layout.workspaceId); }
  return top;
}
const notionName = (name: string) => name.replace(/(?: |%20)[a-f\d]{32}(?=\.|$)/gi, '');
export async function importFile(pages: Pages, actor: Actor, wid: string, parentId: string | null, name: string, bytes: Uint8Array): Promise<string[]> {
  assertTransferAccess(pages, actor, wid);
  if (parentId && pages.get(actor, parentId, true).workspaceId !== wid) fail(400, 'Parent belongs to another workspace.');
  const extension = extname(name).toLowerCase();
  if (bytes.length > (extension === '.zip' ? 200 : 20) * 1024 * 1024) fail(400, 'Import is too large.');
  if (extension === '.json') return importJson(pages, actor, wid, parentId, JSON.parse(strFromU8(bytes)), {});
  let entries: Record<string, Uint8Array>;
  if (extension === '.zip') {
    let expanded = 0;
    entries = unzipSync(bytes, { filter: entry => {
      expanded += entry.originalSize;
      if (expanded > 400 * 1024 * 1024 || entry.originalSize > 200 * 1024 * 1024) fail(400, 'Expanded archive is too large.');
      if (entry.name.startsWith('/') || entry.name.split(/[\\/]/).includes('..')) fail(400, 'Unsafe archive path.');
      return true;
    } });
    if (entries['cairn.json']) return importJson(pages, actor, wid, parentId, JSON.parse(strFromU8(entries['cairn.json'])), entries);
  } else if (['.md', '.markdown', '.txt', '.csv'].includes(extension)) entries = { [basename(name)]: bytes };
  else return fail(400, 'Unsupported import format.');
  const folders = new Map<string, string>(), top: string[] = [], docs = new Map<string, string>();
  const normalized = (path: string) => path.split('/').map(notionName).join('/');
  const ensure = (path: string): string | null => {
    if (!path || path === '.') return parentId;
    if (folders.has(path)) return folders.get(path)!;
    const parent = ensure(posix.dirname(path));
    const page = pages.create(actor, wid, { parentId: parent, title: posix.basename(path) });
    folders.set(path, page.id); if (parent === parentId) top.push(page.id); return page.id;
  };
  const contentEntries = Object.entries(entries).filter(([path]) => /\.(md|markdown|txt|csv)$/i.test(path) && !path.startsWith('__MACOSX/')).sort(([a], [b]) => a.split('/').length - b.split('/').length || Number(!a.endsWith('.csv')) - Number(!b.endsWith('.csv')));
  // Create pages/databases before attaching children, including empty container folders.
  for (const [path, content] of contentEntries) {
    const cleanPath = normalized(path), stem = cleanPath.replace(/\.[^.]+$/, ''), directory = posix.dirname(cleanPath);
    const parent = ensure(directory);
    let source = strFromU8(content);
    let metadataTitle: string | undefined;
    if (!/\.csv$/i.test(path)) {
      const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
      if (frontMatter) {
        const value = /^title:\s*(.*)$/m.exec(frontMatter[1])?.[1]?.trim();
        if (value) { try { const decoded: unknown = JSON.parse(value); if (typeof decoded === 'string') metadataTitle = decoded; } catch { metadataTitle = value; } }
        source = source.slice(frontMatter[0].length).replace(/^\r?\n/, '');
      }
    }
    if (/\.csv$/i.test(path)) {
      const page = importCsv(pages, actor, wid, parent, posix.basename(stem), source);
      folders.set(stem, page.id); docs.set(path, page.id); if (parent === parentId) top.push(page.id);
    } else {
      const title = /^#\s+(.+)$/m.exec(source)?.[1]?.trim() ?? metadataTitle ?? posix.basename(stem);
      const db = parent ? pages.get(actor, parent) : null;
      let page = db?.kind === 'database' ? pages.list(actor, wid).find(row => row.parentId === parent && row.title === title) : undefined;
      page ??= pages.create(actor, wid, { parentId: parent, title, ...(db?.kind === 'database' ? { kind: 'row' } : {}) });
      pages.patch(actor, page.id, { content: markdownToDoc(source) }); folders.set(stem, page.id); docs.set(path, page.id); if (parent === parentId) top.push(page.id);
    }
  }
  const uploaded = new Map<string, string>();
  for (const [path, pageId] of docs) {
    const page = pages.get(actor, pageId);
    const walk = async (node: any): Promise<void> => {
      if (node.type === 'image' && typeof node.attrs?.src === 'string' && !/^(?:[a-z]+:|\/)/i.test(node.attrs.src)) {
        let target: string; try { target = posix.normalize(posix.join(posix.dirname(path), decodeURIComponent(node.attrs.src))); } catch { target = ''; }
        if (entries[target]) { if (!uploaded.has(target)) uploaded.set(target, await storeImportFile(pages, actor, wid, posix.basename(target), entries[target], imageMime(target))); node.attrs.src = uploaded.get(target); }
      }
      for (const child of node.content ?? []) await walk(child);
    };
    if (page.content) { await walk(page.content); assertTransferAccess(pages, actor, wid); pages.patch(actor, page.id, { content: page.content }); }
  }
  return [...new Set(top)];
}

export function registerTransfer(app: Hono<Env>, pages: Pages, fetchImpl: typeof fetch = fetch) {
  const jobs = new Jobs();
  app.get('/api/jobs/:id', c => c.json(jobs.get(c.req.param('id'), c.get('actor').user.id,c.get('actor').workspaceId)));
  app.get('/api/pages/:id/export', c => {
    const format = c.req.query('format') ?? 'md';
    const result = exportPage(pages, c.get('actor'), c.req.param('id'), format);
    c.header('Content-Type', format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8');
    return c.body(result);
  });
  app.get('/api/workspaces/:wid/export', async c => { const bytes = await exportWorkspace(pages, c.get('actor'), c.req.param('wid')); c.header('Content-Type', 'application/zip'); c.header('Content-Disposition', 'attachment; filename="cairn.zip"'); return c.body(bytes as Uint8Array<ArrayBuffer>); });
  app.post('/api/workspaces/:wid/import', async c => {
    const actor = c.get('actor'), wid = c.req.param('wid'); membership(pages.s, actor, wid, true);
    if (Number(c.req.header('content-length') ?? 0) > 201 * 1024 * 1024) fail(400, 'Import is too large.');
    let form: FormData; try { form = await c.req.formData(); } catch { return fail(400, 'A multipart file is required.'); }
    const file = form.get('file'); if (!file || typeof file === 'string') return fail(400, 'A file is required.');
    if (file.size > (/\.zip$/i.test(file.name) ? 200 : 20) * 1024 * 1024) fail(400, 'Import is too large.');
    const parentId = typeof form.get('parentId') === 'string' && form.get('parentId') ? String(form.get('parentId')) : null;
    if (parentId && pages.get(actor, parentId, true).workspaceId !== wid) fail(400, 'Parent belongs to another workspace.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    return c.json(jobs.start(actor.user.id, 'import', async progress => { progress('Importing ' + file.name); return { pageIds: await importFile(pages, actor, wid, parentId, file.name, bytes) }; },wid));
  });
  const credentials = z.object({ token: z.string().min(1).max(1000) });
  app.post('/api/workspaces/:wid/notion/sources', async c => { const actor = c.get('actor'), wid = c.req.param('wid'); membership(pages.s, actor, wid); const input = await body(c, credentials); return c.json(await new Notion(pages, actor, wid, input.token, fetchImpl).sources()); });
  app.post('/api/workspaces/:wid/notion/import', async c => {
    const actor = c.get('actor'), wid = c.req.param('wid'); membership(pages.s, actor, wid, true);
    const input = await body(c, credentials.extend({ sourceIds: z.array(z.string().min(1)).min(1).max(100), parentId: z.string().nullable().optional() }));
    if (input.parentId && pages.get(actor, input.parentId, true).workspaceId !== wid) fail(400, 'Parent belongs to another workspace.');
    return c.json(jobs.start(actor.user.id, 'notion-import', async progress => ({ pageIds: await new Notion(pages, actor, wid, input.token, fetchImpl).import(input.sourceIds, input.parentId ?? null, progress) }),wid));
  });
  app.post('/api/workspaces/:wid/notion/export', async c => {
    const actor = c.get('actor'), wid = c.req.param('wid'); membership(pages.s, actor, wid, true);
    const input = await body(c, credentials.extend({ pageId: z.string(), notionParentPageId: z.string().min(1) }));
    if (pages.get(actor, input.pageId).workspaceId !== wid) fail(400, 'Page belongs to another workspace.');
    return c.json(jobs.start(actor.user.id, 'notion-export', async progress => ({ url: await new Notion(pages, actor, wid, input.token, fetchImpl).export(input.pageId, input.notionParentPageId, progress) }),wid));
  });
}
