import type { DocNode, NotionSource, Page, Property, Props, PropValue, OptionColor } from '../../shared/types.ts';
import { Pages } from './pages.ts';
import type { Actor } from './common.ts';
import { id } from './db.ts';
import { storeImportFile, displayValue, assertTransferAccess } from './transfer.ts';
import { safeDownload } from './outbound.ts';

const plain = (rich: any[] = []) => rich.map(item => item.plain_text ?? item.text?.content ?? '').join('');
const norm = (value: string) => value.replace(/-/g, '');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const colors = new Set(['gray', 'brown', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'red']);
export function notionSchema(properties: Record<string, any>) {
  const schema: Property[] = [], mapping = new Map<string, { property: Property; kind: string; target?: string }>();
  let titleName = 'Name';
  for (const [name, value] of Object.entries(properties)) {
    if (value.type === 'title') { titleName = name; continue; }
    const direct = ['number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'relation'];
    const property: Property = { id: id(), name, type: direct.includes(value.type) ? value.type : ['created_time', 'last_edited_time'].includes(value.type) ? 'date' : 'text' };
    if (['select', 'multi_select', 'status'].includes(value.type)) property.options = (value[value.type]?.options ?? []).map((option: any) => ({ id: id(), name: option.name, color: colors.has(option.color) ? option.color : 'gray' }));
    schema.push(property); mapping.set(name, { property, kind: value.type, target: value.relation?.data_source_id ?? value.relation?.database_id });
  }
  return { schema, mapping, titleName };
}
function notionValue(value: any, property: Property): PropValue {
  if (!value) return null;
  const v = value[value.type];
  switch (value.type) {
    case 'rich_text': case 'title': return plain(v);
    case 'select': case 'status': return property.options?.find(option => option.name === v?.name)?.id ?? null;
    case 'multi_select': return (v ?? []).flatMap((item: any) => property.options?.find(option => option.name === item.name)?.id ?? []);
    case 'relation': return (v ?? []).map((item: any) => item.id);
    case 'people': return (v ?? []).map((person: any) => person.name ?? '').join(', ');
    case 'created_by': case 'last_edited_by': return v?.name ?? null;
    case 'date': return v?.start ?? null;
    case 'unique_id': return v ? `${v.prefix ? v.prefix + '-' : ''}${v.number}` : null;
    case 'formula': return v?.[v.type] == null ? null : typeof v[v.type] === 'object' ? v[v.type].start ?? null : String(v[v.type]);
    case 'rollup': return v?.type === 'number' ? String(v.number ?? '') : v?.type === 'array' ? v.array.map((item: any) => plain(item.rich_text ?? item.title) || item.number || '').join(', ') : v?.date?.start ?? null;
    case 'files': return (v ?? []).map((file: any) => file.name ?? '').join(';');
    default: return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
  }
}
function inline(rich: any[] = []): DocNode[] {
  return rich.flatMap(item => {
    const text = item.plain_text ?? item.text?.content ?? '';
    if (!text) return [];
    const marks: NonNullable<DocNode['marks']> = [];
    for (const [key, type] of [['bold', 'bold'], ['italic', 'italic'], ['strikethrough', 'strike'], ['code', 'code'], ['underline', 'underline']] as const) if (item.annotations?.[key]) marks.push({ type });
    const href = item.href ?? item.text?.link?.url;
    if (href) marks.push({ type: 'link', attrs: { href } });
    return [{ type: 'text', text, ...(marks.length ? { marks } : {}) }];
  });
}
const para = (rich: any[] = []): DocNode => ({ type: 'paragraph', content: inline(rich) });
/** A token is held only by the in-flight task instance, never by the Store or Job. */
export class Notion {
  private lastRequest = 0;
  private mutatingTask = false;
  private check() { assertTransferAccess(this.pages, this.actor, this.wid, this.mutatingTask); }
  private imported = new Map<string, string>();
  private databases: { source: string; page: Page; mapping: ReturnType<typeof notionSchema>['mapping'] }[] = [];
  private relations: { row: string; props: Props }[] = [];
  constructor(private pages: Pages, private actor: Actor, private wid: string, private token: string, private fetchImpl: typeof fetch = fetch) {}
  async request(method: string, path: string, body?: any): Promise<any> {
    for (let attempt = 0; attempt < 7; attempt++) {
      await sleep(Math.max(0, 340 - (Date.now() - this.lastRequest))); this.lastRequest = Date.now();
      this.check();
      const response = await this.fetchImpl('https://api.notion.com/v1' + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: 'Bearer ' + this.token, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if ((response.status === 429 || response.status >= 500) && attempt < 6) {
        await response.body?.cancel(); const retry = Number(response.headers.get('retry-after'));
        await sleep(Math.min(60000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 1000 * 2 ** attempt)); continue;
      }
      if (!response.ok) throw new Error('Notion request failed (' + response.status + ').');
      return response.json();
    }
    throw new Error('Notion retry limit reached.');
  }
  async all(method: string, path: string, body: any = {}): Promise<any[]> {
    const result: any[] = []; let cursor: string | undefined; const seen = new Set<string>();
    do {
      const data = await this.request(method, method === 'GET' ? path + (path.includes('?') ? '&' : '?') + 'page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '') : path, method === 'GET' ? undefined : { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      result.push(...(data.results ?? [])); cursor = data.has_more ? data.next_cursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error('Notion pagination cursor repeated.'); if (cursor) seen.add(cursor);
    } while (cursor);
    return result;
  }
  async sources(): Promise<NotionSource[]> {
    const results = await this.all('POST', '/search');
    return results.filter(item => item.object === 'data_source' || item.object === 'page' && !['data_source_id', 'database_id', 'page_id'].includes(item.parent?.type)).map(item => ({
      id: item.id, kind: item.object === 'data_source' ? 'database' : 'page', title: plain(item.title ?? Object.values<any>(item.properties ?? {}).find(value => value.type === 'title')?.title), icon: item.icon?.emoji ?? '',
    }));
  }
  private async image(url: string, name: string): Promise<string> {
    const download = await safeDownload(url, this.fetchImpl, 20 * 1024 * 1024);
    const bytes = download.data;
    const mime = download.mime;
    if (!mime.startsWith('image/')) throw new Error('Notion image is not an image.');
    return storeImportFile(this.pages, this.actor, this.wid, name, bytes, mime);
  }
  private async blocks(blockId: string, parentId: string, progress: (message: string) => void, depth = 0): Promise<DocNode[]> {
    if (depth > 100) throw new Error('Notion nesting limit exceeded.');
    const blocks = await this.all('GET', '/blocks/' + encodeURIComponent(blockId) + '/children');
    const output: DocNode[] = [];
    const list = (type: string, child: DocNode) => { const last = output.at(-1); if (last?.type === type) last.content!.push(child); else output.push({ type, content: [child] }); };
    for (const block of blocks) {
      const data = block[block.type] ?? {};
      if (block.type === 'child_page') { await this.importPage(block.id, parentId, progress); continue; }
      if (block.type === 'child_database') {
        const database = await this.request('GET', '/databases/' + encodeURIComponent(block.id));
        for (const source of database.data_sources ?? []) await this.importDatabase(source.id, parentId, progress);
        continue;
      }
      const children = block.has_children ? await this.blocks(block.id, parentId, progress, depth + 1) : [];
      switch (block.type) {
        case 'paragraph': case 'toggle': output.push(para(data.rich_text), ...children); break;
        case 'heading_1': case 'heading_2': case 'heading_3': output.push({ type: 'heading', attrs: { level: Number(block.type.at(-1)) }, content: inline(data.rich_text) }, ...children); break;
        case 'bulleted_list_item': list('bulletList', { type: 'listItem', content: [para(data.rich_text), ...children] }); break;
        case 'numbered_list_item': list('orderedList', { type: 'listItem', content: [para(data.rich_text), ...children] }); break;
        case 'to_do': list('taskList', { type: 'taskItem', attrs: { checked: !!data.checked }, content: [para(data.rich_text), ...children] }); break;
        case 'quote': output.push({ type: 'blockquote', content: [para(data.rich_text), ...children] }); break;
        case 'callout': output.push({ type: 'callout', attrs: { emoji: data.icon?.emoji ?? '💡' }, content: [para(data.rich_text), ...children] }); break;
        case 'code': output.push({ type: 'codeBlock', attrs: { language: data.language ?? '' }, content: plain(data.rich_text) ? [{ type: 'text', text: plain(data.rich_text) }] : [] }); break;
        case 'divider': output.push({ type: 'horizontalRule' }); break;
        case 'image': {
          const url = data[data.type]?.url;
          if (url) output.push({ type: 'image', attrs: { src: await this.image(url, 'notion-image-' + block.id + '.png'), alt: plain(data.caption) } }); break;
        }
        case 'bookmark': case 'embed': case 'link_preview': if (data.url) output.push({ type: 'paragraph', content: [{ type: 'text', text: data.url, marks: [{ type: 'link', attrs: { href: data.url } }] }] }); break;
        default: if (data.rich_text) output.push(para(data.rich_text)); output.push(...children);
      }
    }
    return output;
  }
  private async importPage(sourceId: string, parentId: string | null, progress: (message: string) => void, source?: any): Promise<string> {
    const previous = this.imported.get(norm(sourceId)); if (previous) return previous;
    source ??= await this.request('GET', '/pages/' + encodeURIComponent(sourceId));
    const title = plain(Object.values<any>(source.properties ?? {}).find(property => property.type === 'title')?.title);
    progress('Importing ' + title);
    this.check();
    const page = this.pages.create(this.actor, this.wid, { parentId, title, icon: source.icon?.emoji ?? '' });
    this.imported.set(norm(sourceId), page.id);
    const content = await this.blocks(sourceId, page.id, progress);
    this.check();
    this.pages.patch(this.actor, page.id, { content: { type: 'doc', content } });
    return page.id;
  }
  private async importDatabase(sourceId: string, parentId: string | null, progress: (message: string) => void): Promise<string> {
    const previous = this.imported.get(norm(sourceId)); if (previous) return previous;
    const source = await this.request('GET', '/data_sources/' + encodeURIComponent(sourceId));
    const { schema, mapping, titleName } = notionSchema(source.properties ?? {});
    const title = plain(source.title);
    this.check();
    const database = this.pages.create(this.actor, this.wid, { parentId, kind: 'database', title, icon: source.icon?.emoji ?? '', schema });
    if (!schema.length) { database.schema = []; this.pages.change(this.actor, database, 'updated'); }
    this.imported.set(norm(sourceId), database.id);
    if (source.parent?.database_id) this.imported.set(norm(source.parent.database_id), database.id);
    this.databases.push({ source: sourceId, page: database, mapping });
    const rows = await this.all('POST', '/data_sources/' + encodeURIComponent(sourceId) + '/query'); let count = 0;
    for (const sourceRow of rows) {
      if (sourceRow.archived || sourceRow.in_trash) continue;
      const props: Props = {}, relations: Props = {};
      for (const [name, value] of Object.entries<any>(sourceRow.properties ?? {})) {
        const entry = mapping.get(name); if (!entry) continue;
        let complete = value;
        if (value.type === 'relation' && value.has_more && value.id) {
          const items = await this.all('GET', '/pages/' + encodeURIComponent(sourceRow.id) + '/properties/' + encodeURIComponent(value.id));
          complete = { ...value, relation: items.map(item => item.relation ?? item) };
        }
        const mapped = notionValue(complete, entry.property);
        if (entry.kind === 'relation') relations[entry.property.id] = mapped;
        else if (mapped !== null) props[entry.property.id] = mapped;
      }
      this.check();
      const row = this.pages.create(this.actor, this.wid, { parentId: database.id, kind: 'row', title: plain(sourceRow.properties?.[titleName]?.title), icon: sourceRow.icon?.emoji ?? '', props });
      this.imported.set(norm(sourceRow.id), row.id); this.relations.push({ row: row.id, props: relations });
      const content = await this.blocks(sourceRow.id, row.id, progress);
      this.check();
      this.pages.patch(this.actor, row.id, { content: { type: 'doc', content } });
      progress(title + ': ' + (++count) + ' of ' + rows.length + ' rows');
    }
    return database.id;
  }
  async import(sourceIds: string[], parentId: string | null, progress: (message: string) => void): Promise<string[]> {
    this.mutatingTask = true; this.check();
    if (parentId && this.pages.get(this.actor, parentId, true).workspaceId !== this.wid) throw new Error('Parent belongs to another workspace.');
    const sources = await this.sources(); const top: string[] = [];
    for (const sourceId of sourceIds) {
      const source = sources.find(source => norm(source.id) === norm(sourceId));
      if (source?.kind === 'database') top.push(await this.importDatabase(sourceId, parentId, progress));
      else if (source?.kind === 'page') top.push(await this.importPage(sourceId, parentId, progress));
      else {
        // Sources nested under pages do not appear among top-level search results.
        let page: any; try { page = await this.request('GET', '/pages/' + encodeURIComponent(sourceId)); } catch { /* A data source is not a page. */ }
        top.push(page ? await this.importPage(sourceId, parentId, progress, page) : await this.importDatabase(sourceId, parentId, progress));
      }
    }
    this.check();
    for (const database of this.databases) {
      for (const entry of database.mapping.values()) if (entry.target) entry.property.relationDatabaseId = this.imported.get(norm(entry.target));
      this.pages.patch(this.actor, database.page.id, { schema: database.page.schema });
    }
    for (const entry of this.relations) this.pages.patch(this.actor, entry.row, { props: Object.fromEntries(Object.entries(entry.props).map(([key, ids]) => [key, Array.isArray(ids) ? ids.flatMap(source => this.imported.get(norm(source)) ?? []) : []])) });
    return [...new Set(top)];
  }
  private rich(nodes: DocNode[]): any[] {
    return nodes.flatMap(node => {
      const text = node.type === 'hardBreak' ? '\n' : node.type === 'pageLink' ? String(node.attrs?.title ?? '') : node.text ?? '';
      const annotations: Record<string, boolean> = {};
      for (const mark of node.marks ?? []) { const key = ({ bold: 'bold', italic: 'italic', strike: 'strikethrough', code: 'code', underline: 'underline' } as Record<string, string>)[mark.type]; if (key) annotations[key] = true; }
      const link = node.marks?.find(mark => mark.type === 'link')?.attrs?.href;
      return text.match(/[\s\S]{1,2000}/gu)?.map(content => ({ type: 'text', text: { content, ...(link ? { link: { url: link } } : {}) }, ...(Object.keys(annotations).length ? { annotations } : {}) })) ?? [];
    });
  }
  private exportBlocks(nodes: DocNode[]): any[] {
    const block = (type: string, data: any) => ({ object: 'block', type, [type]: data });
    return nodes.flatMap(node => {
      if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) return (node.content ?? []).map(item => {
        const [first, ...rest] = item.content ?? [];
        const type = node.type === 'bulletList' ? 'bulleted_list_item' : node.type === 'orderedList' ? 'numbered_list_item' : 'to_do';
        return block(type, { rich_text: this.rich(first?.content ?? []), ...(type === 'to_do' ? { checked: !!item.attrs?.checked } : {}), ...(rest.length ? { children: this.exportBlocks(rest) } : {}) });
      });
      if (node.type === 'image') {
        let url = String(node.attrs?.src ?? '');
        if (url.startsWith('/')) url = (process.env.CAIRN_PUBLIC_URL ?? '').replace(/\/$/, '') + url;
        if (!/^https?:\/\//.test(url)) return [];
        return [block('image', { type: 'external', external: { url }, caption: this.rich([{ type: 'text', text: String(node.attrs?.alt ?? '') }]) })];
      }
      if (node.type === 'horizontalRule') return [block('divider', {})];
      if (node.type === 'blockquote' || node.type === 'callout') {
        const [first, ...rest] = node.content ?? [];
        return [block(node.type === 'blockquote' ? 'quote' : 'callout', { rich_text: this.rich(first?.content ?? []), ...(node.type === 'callout' ? { icon: { type: 'emoji', emoji: node.attrs?.emoji ?? '💡' } } : {}), ...(rest.length ? { children: this.exportBlocks(rest) } : {}) })];
      }
      const type = node.type === 'heading' ? 'heading_' + Math.min(3, Math.max(1, Number(node.attrs?.level ?? 1))) : node.type === 'codeBlock' ? 'code' : 'paragraph';
      const rich = this.rich(node.content ?? (node.text ? [node] : []));
      // Rich text arrays themselves also have a 100-item limit.
      const chunks: any[] = []; for (let i = 0; i < Math.max(1, rich.length); i += 100) chunks.push(block(type, { rich_text: rich.slice(i, i + 100), ...(type === 'code' ? { language: node.attrs?.language || 'plain text' } : {}) }));
      return chunks;
    });
  }
  private async append(blockId: string, blocks: any[]): Promise<void> {
    // Every rich-text array and nested child list is independently bounded. Split
    // large list items/quotes without dropping text, then append nested children.
    blocks = blocks.flatMap(item => {
      const original = item[item.type], key = original.rich_text ? 'rich_text' : original.caption ? 'caption' : null;
      if (!key) return [item];
      const groups: any[][] = []; let group: any[] = [], size = 0;
      for (const rich of original[key]) {
        const length = Buffer.byteLength(JSON.stringify(rich));
        if (group.length && (group.length >= 100 || size + length > 300000)) { groups.push(group); group = []; size = 0; }
        group.push(rich); size += length;
      }
      if (group.length || !groups.length) groups.push(group);
      return groups.map((rich, index) => {
        const type = key === 'caption' && index > 0 ? 'paragraph' : item.type;
        const data = type === item.type ? { ...original, [key]: rich } : { rich_text: rich };
        if (index < groups.length - 1) delete data.children;
        return { object: 'block', type, [type]: data };
      });
    });
    for (let i = 0; i < blocks.length;) {
      this.check();
      const batch: any[] = []; let size = 0;
      while (i < blocks.length && batch.length < 100) {
        const item = blocks[i], data = { ...item[item.type] }; delete data.children;
        const length = Buffer.byteLength(JSON.stringify({ ...item, [item.type]: data }));
        if (batch.length && size + length > 450000) break;
        size += length; batch.push(item); i++;
      }
      const response = await this.request('PATCH', '/blocks/' + encodeURIComponent(blockId) + '/children', { children: batch.map(item => { const data = { ...item[item.type] }; delete data.children; return { ...item, [item.type]: data }; }) });
      for (let j = 0; j < batch.length; j++) if (batch[j][batch[j].type].children?.length) await this.append(response.results[j].id, batch[j][batch[j].type].children);
    }
  }

  async export(pageId: string, notionParentPageId: string, progress: (message: string) => void): Promise<string> {
    this.mutatingTask = true; this.check();
    const page = this.pages.get(this.actor, pageId);
    if (page.workspaceId !== this.wid) throw new Error('Page belongs to another workspace.');
    progress('Exporting ' + page.title);
    const title = this.rich([{ type: 'text', text: page.title || 'Untitled' }]).slice(0, 100);
    if (page.kind === 'database') {
      const properties: Record<string, any> = { Name: { title: {} } };
      const names = new Map<string, string>();
      for (const property of page.schema) {
        let name = property.name || 'Property'; while (properties[name]) name += ' ';
        names.set(property.id, name);
        const type = ['relation', 'person', 'status'].includes(property.type) ? property.type === 'status' ? 'select' : 'rich_text' : property.type === 'text' ? 'rich_text' : property.type;
        properties[name] = { [type]: property.options ? { options: property.options.map(option => ({ name: option.name, color: option.color === 'teal' ? 'blue' : option.color })) } : {} };
      }
      const database = await this.request('POST', '/databases', { parent: { type: 'page_id', page_id: notionParentPageId }, title, initial_data_source: { properties } });
      const sourceId = database.data_sources?.[0]?.id;
      if (!sourceId) throw new Error('Created Notion database has no data source.');
      const rows = this.pages.list(this.actor, this.wid).filter(row => row.parentId === page.id && row.kind === 'row'); let count = 0;
      for (const row of rows) {
        const values: Record<string, any> = { Name: { title: this.rich([{ type: 'text', text: row.title || 'Untitled' }]).slice(0, 100) } };
        for (const property of page.schema) {
          const value = row.props[property.id]; if (value == null) continue;
          const display = displayValue(this.pages, property, value, this.actor), name = names.get(property.id)!;
          if (property.type === 'number' || property.type === 'checkbox' || property.type === 'url') values[name] = { [property.type]: value };
          else if (property.type === 'date') values[name] = { date: { start: value } };
          else if (property.type === 'select' || property.type === 'status') values[name] = { select: display ? { name: display } : null };
          else if (property.type === 'multi_select') values[name] = { multi_select: (Array.isArray(value) ? value : []).flatMap(optionId => { const option = property.options?.find(option => option.id === optionId); return option ? [{ name: option.name }] : []; }) };
          else values[name] = { rich_text: this.rich([{ type: 'text', text: display }]).slice(0, 100) };
        }
        const created = await this.request('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: sourceId }, properties: values });
        await this.append(created.id, this.exportBlocks(row.content?.content ?? []));
        for (const child of this.pages.list(this.actor, this.wid).filter(child => child.parentId === row.id)) await this.export(child.id, created.id, progress);
        progress(page.title + ': ' + (++count) + ' of ' + rows.length + ' rows');
      }
      return database.url ?? 'https://www.notion.so/' + norm(database.id);
    }
    const created = await this.request('POST', '/pages', { parent: { type: 'page_id', page_id: notionParentPageId }, properties: { title: { title } }, ...(page.icon ? { icon: { type: 'emoji', emoji: page.icon } } : {}) });
    await this.append(created.id, this.exportBlocks(page.content?.content ?? []));
    for (const child of this.pages.list(this.actor, this.wid).filter(child => child.parentId === page.id)) await this.export(child.id, created.id, progress);
    return created.url ?? 'https://www.notion.so/' + norm(created.id);
  }
}
