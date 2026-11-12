import type { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { tokenActor } from './auth.ts';
import { fail, membership, publicUrl, type Actor, type Env } from './common.ts';
import { id } from './db.ts';
import { Pages } from './pages.ts';
import { docToMarkdown, markdownToDoc } from '../../shared/markdown.ts';
import { applyView } from '../../shared/query.ts';
import type { Filter, Page, Property, Props, PropValue, Sort } from '../../shared/types.ts';

const text = z.string();
const identifier = z.string().min(1);
const limitSchema = z.number().int().min(1).max(200).optional();
const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
const valuesSchema = z.record(z.string(), valueSchema);
const optionSchema = z.union([z.string(), z.object({ name: z.string(), color: z.enum(['gray', 'brown', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'red']).optional() })]);
const propertySchema = z.object({ name: z.string().min(1), type: z.enum(['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'person', 'relation']), options: z.array(optionSchema).optional() });
const filterSchema = z.object({ property: z.string().optional(), propertyId: z.string().optional(), op: z.enum(['contains', 'not_contains', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is_empty', 'is_not_empty', 'checked', 'unchecked']), value: valueSchema.optional() }).refine(v => !!(v.property ?? v.propertyId), 'A filter requires a property name.');
const sortSchema = z.object({ property: z.string().optional(), propertyId: z.string().optional(), dir: z.enum(['asc', 'desc']) }).refine(v => !!(v.property ?? v.propertyId), 'A sort requires a property name.');

function newProperty(input: z.infer<typeof propertySchema>): Property {
  return { id: id(), name: input.name, type: input.type, ...(input.options ? { options: input.options.map(option => ({ id: id(), name: typeof option === 'string' ? option : option.name, color: typeof option === 'string' ? 'gray' as const : option.color ?? 'gray' as const })) } : {}) };
}
function namedProperty(database: Page, name: string): Property {
  return database.schema.find(property => property.name === name || property.id === name) ?? fail(400, `Property "${name}" does not exist.`);
}
function databasePage(pages: Pages, actor: Actor, databaseId: string, write = false): Page {
  const database = pages.get(actor, databaseId, write);
  if (database.kind !== 'database') fail(400, 'The requested page is not a database.');
  return database;
}
function resolveValue(property: Property, value: PropValue): PropValue {
  if (property.options) {
    if (Array.isArray(value)) return value.map(v => property.options!.find(option => option.id === v)?.name ?? v);
    if (typeof value === 'string') return property.options.find(option => option.id === value)?.name ?? value;
  }
  return value;
}
function namedProps(database: Page, props: Props): Props {
  return Object.fromEntries(database.schema.filter(property => property.id in props).map(property => [property.name, resolveValue(property, props[property.id])]));
}
function convertProperties(pages: Pages, actor: Actor, database: Page, input: Props): Props {
  const props: Props = {};
  let changed = false;
  for (const [name, value] of Object.entries(input)) {
    const property = namedProperty(database, name);
    if (value === null) { props[property.id] = null; continue; }
    const optionId = (name: string) => {
      property.options ??= [];
      const existing = property.options.find(option => option.name === name || option.id === name);
      if (existing) return existing.id;
      const option = { id: id(), name, color: 'gray' as const };
      property.options.push(option); changed = true;
      return option.id;
    };
    switch (property.type) {
      case 'select': case 'status':
        if (typeof value !== 'string') fail(400, `Property "${name}" requires an option name.`);
        props[property.id] = optionId(value as string); break;
      case 'multi_select':
        if (!Array.isArray(value)) fail(400, `Property "${name}" requires an array of option names.`);
        props[property.id] = (value as string[]).map(optionId); break;
      case 'person': case 'relation':
        if (!Array.isArray(value)) fail(400, `Property "${name}" requires an array of ids.`);
        props[property.id] = value; break;
      case 'number':
        if (typeof value !== 'number') fail(400, `Property "${name}" requires a number.`);
        props[property.id] = value; break;
      case 'checkbox':
        if (typeof value !== 'boolean') fail(400, `Property "${name}" requires a boolean.`);
        props[property.id] = value; break;
      default:
        if (typeof value !== 'string') fail(400, `Property "${name}" requires text.`);
        props[property.id] = value;
    }
  }
  if (changed) pages.patch(actor, database.id, { schema: database.schema });
  return props;
}
function describePage(pages: Pages, actor: Actor, page: Page) {
  const database = page.kind === 'row' && page.parentId ? databasePage(pages, actor, page.parentId) : null;
  return { id: page.id, workspaceId: page.workspaceId, parentId: page.parentId, kind: page.kind, title: page.title, icon: page.icon, path: [...pages.ancestors(page).map(p => p.title), page.title].join(' / '), properties: database ? namedProps(database, page.props) : {}, markdown: docToMarkdown(page.content), ...(page.kind === 'database' ? { schema: page.schema, views: page.views } : {}) };
}
function visibleWorkspaces(pages: Pages, actor: Actor) {
  const memberships = pages.s.db.prepare('SELECT workspaceId,role FROM memberships WHERE userId=?').all(actor.user.id);
  return memberships.filter(m => !actor.workspaceId || actor.workspaceId === m.workspaceId).flatMap(m => {
    const w = pages.s.get<any>('workspaces', String(m.workspaceId));
    return w ? [{ id: w.id, name: w.name, icon: w.icon, color: w.color, role: String(m.role) }] : [];
  });
}

function buildServer(pages: Pages, actor: Actor, publicUrl: string) {
  const server = new McpServer({ name: 'cairn', version: '0.1.0' }, { instructions: `Cairn workspaces contain nested pages. A database is a page whose children are rows; rows have typed properties and their own page body. Content is exchanged as Markdown. Use ids to identify pages and property names and option names to work with database values. Open the workspace at ${publicUrl}.` });
  function tool<T extends z.ZodRawShape>(name: string, description: string, inputSchema: T, write: boolean, callback: (input: z.infer<z.ZodObject<T>>) => unknown) {
    if (write && actor.access !== 'write') return;
    server.registerTool<z.ZodRawShape, z.ZodObject<T>>(name, { description, inputSchema: z.object(inputSchema), annotations: { readOnlyHint: !write } }, async input => {
      try {
        if (write && actor.access !== 'write') fail(403, 'This token is read only.');
        const result = await callback(input as z.infer<z.ZodObject<T>>);
        return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'The operation could not be completed.' }] };
      }
    });
  }
  tool('list_workspaces', 'List accessible workspaces and your roles.', {}, false, () => visibleWorkspaces(pages, actor));
  tool('search', 'Search accessible page titles, bodies and row properties.', { query: text, workspace_id: identifier.optional(), limit: limitSchema }, false, input => {
    const workspaces = input.workspace_id ? [{ id: input.workspace_id }] : visibleWorkspaces(pages, actor);
    return workspaces.flatMap(w => pages.search(actor, w.id, input.query, input.limit ?? 30)).slice(0, input.limit ?? 30);
  });
  tool('list_pages', 'List child pages, or the root pages of a workspace.', { workspace_id: identifier, parent_id: identifier.optional() }, false, input => {
    if (input.parent_id) { const parent = pages.get(actor, input.parent_id); if (parent.workspaceId !== input.workspace_id) fail(400, 'Parent belongs to another workspace.'); }
    return pages.list(actor, input.workspace_id).filter(p => p.parentId === (input.parent_id ?? null)).sort((a, b) => a.position - b.position).map(p => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, parentId: p.parentId }));
  });
  tool('get_page', 'Read a page, its path, named properties and Markdown body.', { page_id: identifier }, false, input => describePage(pages, actor, pages.get(actor, input.page_id)));
  tool('create_page', 'Create a page with optional Markdown content.', { workspace_id: identifier, title: text, parent_id: identifier.optional(), markdown: text.optional(), icon: text.optional() }, true, input => describePage(pages, actor, pages.create(actor, input.workspace_id, { title: input.title, parentId: input.parent_id, icon: input.icon, content: input.markdown === undefined ? null : markdownToDoc(input.markdown) })));
  tool('update_page', 'Update a title or icon and optionally replace the Markdown body.', { page_id: identifier, title: text.optional(), icon: text.optional(), markdown: text.optional() }, true, input => describePage(pages, actor, pages.patch(actor, input.page_id, { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.icon !== undefined ? { icon: input.icon } : {}), ...(input.markdown !== undefined ? { content: markdownToDoc(input.markdown) } : {}) })));
  tool('append_to_page', 'Append Markdown blocks to a page body.', { page_id: identifier, markdown: text }, true, input => {
    const page = pages.get(actor, input.page_id, true);
    return describePage(pages, actor, pages.patch(actor, page.id, { content: { type: 'doc', content: [...(page.content?.content ?? []), ...(markdownToDoc(input.markdown).content ?? [])] } }));
  });
  tool('move_page', 'Move a page to a new parent or the workspace root.', { page_id: identifier, parent_id: identifier.optional() }, true, input => describePage(pages, actor, pages.move(actor, input.page_id, input.parent_id ?? null)));
  tool('delete_page', 'Move a page and its descendants to trash.', { page_id: identifier }, true, input => { pages.remove(actor, input.page_id); return `Moved page ${input.page_id} to trash.`; });
  tool('get_database', 'Read a database schema and its saved views.', { database_id: identifier }, false, input => {
    const database = databasePage(pages, actor, input.database_id); return { id: database.id, title: database.title, schema: database.schema, views: database.views };
  });
  tool('create_database', 'Create a database with named, typed properties.', { workspace_id: identifier, title: text, properties: z.array(propertySchema), parent_id: identifier.optional() }, true, input => {
    if (new Set(input.properties.map(p => p.name)).size !== input.properties.length) fail(400, 'Property names must be unique.');
    return describePage(pages, actor, pages.create(actor, input.workspace_id, { title: input.title, kind: 'database', parentId: input.parent_id, schema: input.properties.map(newProperty) }));
  });
  tool('update_database', 'Change a database title, add properties, rename properties or add options.', {
    database_id: identifier, title: text.optional(), add_properties: z.array(propertySchema).optional(),
    rename_properties: z.union([z.record(z.string(), z.string()), z.array(z.object({ name: text, new_name: text }))]).optional(),
    add_options: z.record(z.string(), z.array(optionSchema)).optional()
  }, true, input => {
    const database = databasePage(pages, actor, input.database_id, true);
    for (const property of input.add_properties ?? []) { if (database.schema.some(p => p.name === property.name)) fail(400, `Property "${property.name}" already exists.`); database.schema.push(newProperty(property)); }
    const renames = Array.isArray(input.rename_properties) ? input.rename_properties.map(p => [p.name, p.new_name]) : Object.entries(input.rename_properties ?? {});
    for (const [oldName, newName] of renames) namedProperty(database, oldName).name = newName;
    if (new Set(database.schema.map(p => p.name)).size !== database.schema.length) fail(400, 'Property names must be unique.');
    for (const [name, options] of Object.entries(input.add_options ?? {})) {
      const property = namedProperty(database, name);
      if (!['select', 'multi_select', 'status'].includes(property.type)) fail(400, `Property "${name}" does not have options.`);
      property.options ??= [];
      for (const option of options) {
        const optionName = typeof option === 'string' ? option : option.name;
        if (!property.options.some(o => o.name === optionName)) property.options.push({ id: id(), name: optionName, color: typeof option === 'string' ? 'gray' : option.color ?? 'gray' });
      }
    }
    return describePage(pages, actor, pages.patch(actor, database.id, { schema: database.schema, ...(input.title !== undefined ? { title: input.title } : {}) }));
  });
  tool('query_database', 'Query rows using property names, option names and saved views.', { database_id: identifier, filters: z.array(filterSchema).optional(), sorts: z.array(sortSchema).optional(), view: text.optional(), limit: limitSchema }, false, input => {
    const database = databasePage(pages, actor, input.database_id);
    const view = input.view ? database.views.find(view => view.name === input.view || view.id === input.view) : undefined;
    if (input.view && !view) fail(400, 'The requested view does not exist.');
    const key = (name: string) => ['title', 'createdAt', 'updatedAt'].includes(name) ? name : namedProperty(database, name).id;
    const filters: Filter[] = input.filters ? input.filters.map(filter => {
      const propertyId = key(filter.property ?? filter.propertyId!);
      const property = database.schema.find(p => p.id === propertyId);
      let value = filter.value;
      if (property?.options && value !== undefined && value !== null) {
        const lookup = (name: string) => property.options!.find(o => o.name === name || o.id === name)?.id ?? `unknown:${name}`;
        value = Array.isArray(value) ? value.map(lookup) : typeof value === 'string' ? lookup(value) : value;
      }
      return { propertyId, op: filter.op, ...(value !== undefined ? { value } : {}) };
    }) : view?.filters ?? [];
    const sorts: Sort[] = input.sorts ? input.sorts.map(sort => ({ propertyId: key(sort.property ?? sort.propertyId!), dir: sort.dir })) : view?.sorts ?? [];
    return applyView(pages.rows(actor, database.id), { filters, sorts }, database.schema).slice(0, input.limit ?? 100).map(row => ({ ...row, properties: namedProps(database, row.props), props: undefined }));
  });
  tool('create_row', 'Create a database row using property names; new option names are added automatically.', { database_id: identifier, title: text, properties: valuesSchema.optional(), markdown: text.optional() }, true, input => {
    const database = databasePage(pages, actor, input.database_id, true);
    const props = convertProperties(pages, actor, database, input.properties ?? {});
    return describePage(pages, actor, pages.create(actor, database.workspaceId, { kind: 'row', parentId: database.id, title: input.title, props, content: input.markdown === undefined ? null : markdownToDoc(input.markdown) }));
  });
  tool('update_row', 'Update a row title, named properties or Markdown body.', { row_id: identifier, title: text.optional(), properties: valuesSchema.optional(), markdown: text.optional() }, true, input => {
    const row = pages.get(actor, input.row_id, true);
    if (row.kind !== 'row' || !row.parentId) fail(400, 'The requested page is not a database row.');
    const database = databasePage(pages, actor, row.parentId!, true);
    const props = input.properties ? convertProperties(pages, actor, database, input.properties) : undefined;
    return describePage(pages, actor, pages.patch(actor, row.id, { ...(props ? { props } : {}), ...(input.title !== undefined ? { title: input.title } : {}), ...(input.markdown !== undefined ? { content: markdownToDoc(input.markdown) } : {}) }));
  });
  tool('recent_activity', 'Read recent visible activity in a workspace.', { workspace_id: identifier, limit: limitSchema }, false, input => { membership(pages.s, actor, input.workspace_id); return pages.activity(actor, input.workspace_id, input.limit ?? 50); });
  return server;
}

export function registerMcp(app: Hono<Env>, pages: Pages): void {
  app.all('/mcp', async c => {
    const authenticated = tokenActor(pages.s, c.req.header('Authorization'));
    if (!authenticated) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: { code: 'unauthorized', message: 'A valid bearer API token is required.' } }, 401);
    }
    const actor: Actor = { ...authenticated, actorType: 'ai', clientId: null };
    const server = buildServer(pages, actor, publicUrl(c));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(c.req.raw); }
    finally { await server.close(); }
  });
}
