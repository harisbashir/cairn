import type { Hono } from 'hono';
import { z } from 'zod';
import { body, fail, membership, type Actor, type Env } from './common.ts';
import type { Backlink, Page, DocNode } from '../../shared/types.ts';
import { docToPlainText } from '../../shared/markdown.ts';
import type { Pages } from './pages.ts';
import { clean } from './pages.ts';
import { copyChildren } from './templates.ts';
import { updateComment, deleteComment } from './comments.ts';
import { changeDetail, undoChange } from './changes.ts';

function referenceOffset(node:DocNode|null,targetId:string,origin:string,offset=0):number|undefined {
  if(!node||node.type==='databaseView')return undefined;
  if(node.type==='pageLink'&&node.attrs?.pageId===targetId)return offset;
  if(node.marks?.some(mark=>{
    if(mark.type!=='link'||typeof mark.attrs?.href!=='string')return false;
    try {const url=new URL(mark.attrs.href,origin);return url.origin===new URL(origin).origin&&url.pathname.replace(/\/$/,'')==='/p/'+targetId;}catch{return false;}
  }))return offset;
  const separator=['paragraph','heading'].includes(node.type)?'':'\n';
  for(const child of node.content??[]){const found=referenceOffset(child,targetId,origin,offset);if(found!==undefined)return found;offset+=docToPlainText(child).length+separator.length;}
  return undefined;
}
export function backlinks(pages: Pages, actor: Actor, pageId: string): Backlink[] {
  const target = pages.get(actor, pageId);
  const refs = pages.s.db.prepare('SELECT fromId,via FROM links WHERE toId=?').all(target.id);
  return refs
    .flatMap((ref) => {
      try {
        const page = pages.get(actor, String(ref.fromId));
        if (pages.isTemplate(page)) return [];
        const via = String(ref.via) as Backlink['via'];
        const text = docToPlainText(page.content);
        const index = Math.max(0, (referenceOffset(page.content,target.id,process.env.CAIRN_PUBLIC_URL??actor.requestOrigin??'http://localhost:3000')??0) - 50);
        return [
          {
            id: page.id,
            kind: page.kind,
            title: page.title,
            icon: page.icon,
            path: pages.path(page),
            snippet:
              via === 'relation'
                ? (pages.s.get<Page>('pages', page.parentId ?? '')?.title ?? '')
                : text.slice(index, index + 120),
            via,
            at: page.updatedAt,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ at, ...result }) => result);
}
export function capture(
  pages: Pages,
  actor: Actor,
  input: { title?: string; text?: string; url?: string; workspaceId?: string; databaseId?: string },
): Page {
  let wid = input.workspaceId,
    dbid = input.databaseId;
  if (dbid) {
    const db = pages.get(actor, dbid, true);
    if (db.kind !== 'database' || (wid && wid !== db.workspaceId))
      fail(400, 'Capture target must be a database in this workspace.');
    wid = db.workspaceId;
  }
  if (!wid) {
    wid = actor.user.prefs.capture?.workspaceId;
    dbid ??= actor.user.prefs.capture?.databaseId ?? undefined;
  }
  if (!wid) fail(400, 'Choose where quick capture saves: pass workspaceId (and databaseId), or set a capture destination in Cairn.');
  membership(pages.s, actor, wid, true);
  const database = dbid ? pages.get(actor, dbid, true) : null;
  if (database && (database.kind !== 'database' || database.workspaceId !== wid))
    fail(400, 'Invalid capture database.');
  let url: URL | undefined;
  if (input.url) {
    try {
      url = new URL(input.url);
    } catch {
      fail(400, 'Invalid capture URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) fail(400, 'Capture URLs must use HTTP or HTTPS.');
  }
  const title =
    input.title ?? (url ? url.hostname + url.pathname + (url.search ?? '') : (input.text?.split(/\r?\n/)[0] ?? ''));
  const content: Page['content'] = { type: 'doc', content: [] };
  if (input.text)
    content.content!.push(
      ...input.text
        .split(/\r?\n/)
        .map((text) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) })),
    );
  if (input.url)
    content.content!.push({
      type: 'paragraph',
      content: [{ type: 'text', text: input.url, marks: [{ type: 'link', attrs: { href: input.url } }] }],
    });
  const property = database?.schema.find((p) => p.type === 'url');
  return pages.create(actor, wid, {
    kind: database ? 'row' : 'page',
    parentId: database?.id ?? null,
    title,
    content,
    ...(property && input.url ? { props: { [property.id]: input.url } } : {}),
  });
}
export function registerCollaboration(app: Hono<Env>, pages: Pages): void {
  app.get('/api/workspaces/:wid/templates', (c) => c.json(pages.templates(c.get('actor'), c.req.param('wid'))));
  app.get('/api/pages/:id/templates', (c) => {
    const a = c.get('actor'),
      p = pages.get(a, c.req.param('id'));
    return c.json(pages.templates(a, p.workspaceId, p.id));
  });
  app.post('/api/pages/:id/save-as-template', async (c) => {
    const input = await body(c, z.object({ title: z.string().max(10000).optional() }));
    return c.json(clean(pages.saveAsTemplate(c.get('actor'), c.req.param('id'), input.title)));
  });
  app.post('/api/pages/:id/apply-template', async (c) => {
    const a = c.get('actor'),
      { templateId } = await body(c, z.object({ templateId: z.string() }));
    const page = pages.get(a, c.req.param('id'), true),
      template = pages.get(a, templateId);
    if (page.kind !== 'page' || !template.isTemplate || template.kind !== 'page' || template.workspaceId !== page.workspaceId)
      fail(400, 'Template does not match the destination.');
    const today = pages.today(a);
    const fill = (v: any): any =>
      typeof v === 'string' ? v.replaceAll('{{date}}', today)
        : Array.isArray(v) ? v.map(fill)
          : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
    const result = pages.patch(a, page.id, {
      title: page.title || fill(template.title),
      icon: page.icon || template.icon,
      cover: page.cover || template.cover,
      content: fill(template.content),
    });
    copyChildren(pages, a, template, result);
    return c.json(clean(result));
  });
  app.get('/api/pages/:id/backlinks', (c) => c.json(pages.backlinks(c.get('actor'), c.req.param('id'))));
  app.get('/api/workspaces/:wid/mentionables', (c) => {
    const a = c.get('actor'),
      wid = c.req.param('wid'),
      q = (c.req.query('q') ?? '').toLowerCase();
    membership(pages.s, a, wid);
    const people = pages.s.db
      .prepare('SELECT userId FROM memberships WHERE workspaceId=?')
      .all(wid)
      .flatMap((m) => {
        const u = pages.s.get('users', String(m.userId));
        return u && !u.disabled && u.name.toLowerCase().includes(q) ? [{ id: u.id, name: u.name, color: u.color }] : [];
      })
      .slice(0, 8);
    return c.json({
      pages: pages
        .list(a, wid)
        .filter((p) => !pages.isTemplate(p) && p.title.toLowerCase().includes(q))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 8)
        .map((p) => ({ id: p.id, title: p.title, icon: p.icon, path: pages.path(p) })),
      people,
    });
  });
  app.get('/api/pages/:id/comments', (c) => c.json(pages.comments(c.get('actor'), c.req.param('id'))));
  app.post('/api/pages/:id/comments', async (c) =>
    c.json(
      pages.addComment(
        c.get('actor'),
        c.req.param('id'),
        await body(
          c,
          z.object({
            body: z.string().min(1).max(5000),
            quote: z.string().max(5000).optional(),
            threadId: z.string().optional(),
          }),
        ),
      ),
    ),
  );
  app.patch('/api/comments/:id', async (c) =>
    c.json(
      updateComment(
        pages,
        c.get('actor'),
        c.req.param('id'),
        await body(c, z.object({ body: z.string().min(1).max(5000).optional(), resolved: z.boolean().optional() })),
      ),
    ),
  );
  app.delete('/api/comments/:id', (c) => {
    deleteComment(pages, c.get('actor'), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/api/workspaces/:wid/changes', (c) =>
    c.json(
      pages.changes(c.get('actor'), c.req.param('wid'), {
        actor: c.req.query('actor'),
        client: c.req.query('client'),
        before: c.req.query('before'),
        limit: Math.max(0, Math.min(Number(c.req.query('limit')) || 50, 200)),
      }),
    ),
  );
  app.get('/api/changes/:id', (c) => c.json(changeDetail(pages, c.get('actor'), c.req.param('id'))));
  app.post('/api/changes/:id/undo', async (c) => {
    const input = c.req.header('content-length') === '0' || !c.req.header('content-type') ? {} as { force?: boolean } : await body(c, z.object({ force: z.boolean().optional() }));
    return c.json(undoChange(pages, c.get('actor'), c.req.param('id'), input.force));
  });
  app.post('/api/changes/undo', async (c) => {
    const input = await body(c, z.object({ ids: z.array(z.string()).max(200), force: z.boolean().optional() })),
      a = c.get('actor');
    const result = { undone: [] as string[], conflicts: [] as string[], failed: [] as string[] };
    const ids = [...new Set(input.ids)].sort((x, y) =>
      (pages.s.get('changes', y)?.at ?? '').localeCompare(pages.s.get('changes', x)?.at ?? ''),
    );
    const batch = new Map<string, string>();
    for (const id of ids) {
      try {
        undoChange(pages, a, id, input.force, batch);
        result.undone.push(id);
      } catch (e) {
        if ((e as { status?: number }).status === 409) result.conflicts.push(id);
        else result.failed.push(id);
      }
    }
    return c.json(result);
  });
  app.post('/api/capture', async (c) =>
    c.json({
      page: clean(
        pages.capture(
          c.get('actor'),
          await body(
            c,
            z.object({
              title: z.string().max(10000).optional(),
              text: z.string().max(100000).optional(),
              url: z.string().max(10000).optional(),
              workspaceId: z.string().nullish().transform((v) => v ?? undefined),
              databaseId: z.string().nullish().transform((v) => v ?? undefined),
            }),
          ),
        ),
      ),
    }),
  );
}
