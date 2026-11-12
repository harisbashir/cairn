import type { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { credentialActor } from './credentials.ts';
import { Dashboard, widgetsSchema } from './dashboard.ts';
import { Calendars } from './calendars.ts';
import { safeDownload } from './outbound.ts';
import { storeFile } from './file-storage.ts';
import { exportPage } from './transfer.ts';
import { view as viewSchema } from './page-validation.ts';
import { fail, membership, publicUrl, type Actor, type Env } from './common.ts';
import { id } from './db.ts';
import { Pages } from './pages.ts';
import { docToMarkdown, markdownToDoc } from '../../shared/markdown.ts';
import { applyView } from '../../shared/query.ts';
import type { Filter, Page, Property, Props, PropValue, Sort } from '../../shared/types.ts';

const text = z.string();
const title = z.string().max(10000);
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

function buildServer(pages: Pages, actor: Actor, publicUrl: string, fetchImpl: typeof fetch) {
  const server = new McpServer({ name: 'cairn', version: '0.1.0' }, { instructions: `Cairn workspaces contain nested pages. A database is a page whose children are rows; rows have typed properties and their own page body. Content is exchanged as Markdown. Use ids to identify pages and property names and option names to work with database values. Open the workspace at ${publicUrl}.` });
  function tool<T extends z.ZodRawShape>(name: string, description: string, inputSchema: T, write: boolean, callback: (input: z.infer<z.ZodObject<T>>) => unknown) {
    if (write && actor.access === 'read') return;
    server.registerTool<z.ZodRawShape, z.ZodObject<T>>(name, { description, inputSchema: z.object(inputSchema), annotations: { title: name.replace(/_/g,' '), readOnlyHint: !write, destructiveHint: /^(delete|update|move|restore|set)_/.test(name), idempotentHint: !write || /^(delete|update|set)_/.test(name) } }, async input => {
      try {
        if (write && actor.access === 'read') fail(403, 'This token is read only.');
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
  tool('get_page', 'Read a page, its path, named properties and Markdown body.', { page_id: identifier, include_children: z.boolean().optional() }, false, input => { const page=pages.get(actor,input.page_id);return {...describePage(pages,actor,page),...(input.include_children?{children:pages.list(actor,page.workspaceId).filter(p=>p.parentId===page.id).sort((a,b)=>a.position-b.position).map(p=>({id:p.id,title:p.title,icon:p.icon,kind:p.kind}))}:{})}; });
  tool('create_page', 'Create a page with optional Markdown content.', { workspace_id: identifier, title, parent_id: identifier.optional(), markdown: text.optional(), icon: text.optional() }, true, input => describePage(pages, actor, pages.create(actor, input.workspace_id, { title: input.title, parentId: input.parent_id, icon: input.icon, content: input.markdown === undefined ? null : markdownToDoc(input.markdown) })));
  tool('update_page', 'Update a title or icon and optionally replace the Markdown body.', { page_id: identifier, title: title.optional(), icon: text.optional(), markdown: text.optional() }, true, input => describePage(pages, actor, pages.patch(actor, input.page_id, { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.icon !== undefined ? { icon: input.icon } : {}), ...(input.markdown !== undefined ? { content: markdownToDoc(input.markdown) } : {}) })));
  tool('append_to_page', 'Append Markdown blocks to a page body.', { page_id: identifier, markdown: text }, true, input => {
    const page = pages.get(actor, input.page_id, true);
    return describePage(pages, actor, pages.patch(actor, page.id, { content: { type: 'doc', content: [...(page.content?.content ?? []), ...(markdownToDoc(input.markdown).content ?? [])] } }));
  });
  tool('move_page', 'Move a page to a new parent or the workspace root.', { page_id: identifier, parent_id: identifier.optional() }, true, input => describePage(pages, actor, pages.move(actor, input.page_id, input.parent_id ?? null)));
  tool('delete_page', 'Move a page and its descendants to trash.', { page_id: identifier }, true, input => { pages.remove(actor, input.page_id); return `Moved page ${input.page_id} to trash.`; });
  tool('get_database', 'Read a database schema and its saved views.', { database_id: identifier }, false, input => {
    const database = databasePage(pages, actor, input.database_id); return { id: database.id, title: database.title, schema: database.schema, views: database.views };
  });
  tool('create_database', 'Create a database with named, typed properties.', { workspace_id: identifier, title, properties: z.array(propertySchema), parent_id: identifier.optional() }, true, input => {
    if (new Set(input.properties.map(p => p.name)).size !== input.properties.length) fail(400, 'Property names must be unique.');
    return describePage(pages, actor, pages.create(actor, input.workspace_id, { title: input.title, kind: 'database', parentId: input.parent_id, schema: input.properties.map(newProperty) }));
  });
  tool('update_database', 'Change a database title, add properties, rename properties or add options.', {
    database_id: identifier, title: title.optional(), add_properties: z.array(propertySchema).optional(),
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
  tool('query_database', 'Query rows using property names, option names and saved views.', { database_id: identifier, filters: z.array(filterSchema).optional(), sorts: z.array(sortSchema).optional(), view: text.optional(), limit: limitSchema, offset:z.number().int().min(0).optional() }, false, input => {
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
    const rows=applyView(pages.rows(actor, database.id), { filters, sorts }, database.schema);
    return {total:rows.length,rows:rows.slice(input.offset??0,(input.offset??0)+(input.limit??100)).map(row => ({...row,properties:namedProps(database,row.props),props:undefined}))};
  });
  tool('create_row', 'Create a database row using property names; new option names are added automatically.', { database_id: identifier, title, properties: valuesSchema.optional(), markdown: text.optional() }, true, input => {
    const database = databasePage(pages, actor, input.database_id, true);
    const props = convertProperties(pages, actor, database, input.properties ?? {});
    return describePage(pages, actor, pages.create(actor, database.workspaceId, { kind: 'row', parentId: database.id, title: input.title, props, content: input.markdown === undefined ? null : markdownToDoc(input.markdown) }));
  });
  tool('update_row', 'Update a row title, named properties or Markdown body.', { row_id: identifier, title: title.optional(), properties: valuesSchema.optional(), markdown: text.optional() }, true, input => {
    const row = pages.get(actor, input.row_id, true);
    if (row.kind !== 'row' || !row.parentId) fail(400, 'The requested page is not a database row.');
    const database = databasePage(pages, actor, row.parentId!, true);
    const props = input.properties ? convertProperties(pages, actor, database, input.properties) : undefined;
    return describePage(pages, actor, pages.patch(actor, row.id, { ...(props ? { props } : {}), ...(input.title !== undefined ? { title: input.title } : {}), ...(input.markdown !== undefined ? { content: markdownToDoc(input.markdown) } : {}) }));
  });
  tool('recent_activity', 'Read recent visible activity in a workspace.', { workspace_id: identifier, limit: limitSchema }, false, input => { membership(pages.s, actor, input.workspace_id); return pages.activity(actor, input.workspace_id, input.limit ?? 50); });
  const dashboard=new Dashboard(pages);
  tool('whoami','Read your identity, credential access and reachable workspaces.',{},false,()=>({user:actor.user,access:actor.access??'write',workspaces:visibleWorkspaces(pages,actor)}));
  tool('list_databases','List visible databases and their properties and row counts.',{workspace_id:identifier},false,input=>pages.list(actor,input.workspace_id).filter(p=>p.kind==='database').map(p=>({id:p.id,title:p.title,path:pages.path(p),properties:p.schema.map(p=>p.name),rowCount:pages.rows(actor,p.id).length})));
  tool('list_trash','List visible trashed pages.',{workspace_id:identifier},false,input=>pages.list(actor,input.workspace_id,true).filter(p=>p.deletedAt).map(p=>({id:p.id,kind:p.kind,title:p.title,icon:p.icon,deletedAt:p.deletedAt,deletedByName:pages.s.get('users',p.updatedBy)?.name??'Former member'})));
  tool('restore_page','Restore a trashed page.',{page_id:identifier},true,input=>describePage(pages,actor,pages.restore(actor,input.page_id)));
  tool('duplicate_page','Copy a page and its visible descendants.',{page_id:identifier},true,input=>describePage(pages,actor,pages.duplicate(actor,input.page_id)));
  const viewInput={name:text.optional(),type:viewSchema.shape.type.optional(),group_by:text.optional(),date_property:text.optional(),end_date_property:text.optional(),card_properties:z.array(text).optional(),filters:z.array(filterSchema).optional(),sorts:z.array(sortSchema).optional(),chart:viewSchema.shape.chart.optional()};
  function viewFields(db:Page,input:any) {
    const key=(name:string)=>['title','createdAt','updatedAt'].includes(name)?name:namedProperty(db,name).id;
    const result:any={};
    for(const field of ['name','type'])if(input[field]!==undefined)result[field]=input[field];
    for(const [from,to]of Object.entries({group_by:'groupBy',date_property:'dateProp',end_date_property:'endDateProp'}))if(input[from]!==undefined)result[to]=key(input[from]);
    if(input.card_properties)result.cardProps=input.card_properties.map(key);
    if(input.filters)result.filters=input.filters.map((f:any)=>{const propertyId=key(f.property??f.propertyId),prop=db.schema.find(p=>p.id===propertyId);let value=f.value;if(prop?.options && value!=null){const opt=(v:string)=>prop.options!.find(o=>o.name===v||o.id===v)?.id??fail(400,'Unknown option.');value=Array.isArray(value)?value.map(opt):typeof value==='string'?opt(value):value;}return{propertyId,op:f.op,...(value!==undefined?{value}:{})};});
    if(input.sorts)result.sorts=input.sorts.map((s:any)=>({propertyId:key(s.property??s.propertyId),dir:s.dir}));
    if(input.chart)result.chart={...input.chart,groupBy:key(input.chart.groupBy),...(input.chart.valueProp?{valueProp:key(input.chart.valueProp)}:{})};
    return result;
  }
  tool('add_view','Add a database view using property names.',{database_id:identifier,...viewInput,name:text,type:viewSchema.shape.type},true,input=>{const db=databasePage(pages,actor,input.database_id,true);const view=viewSchema.parse({id:id(),filters:[],sorts:[],...viewFields(db,input)});pages.patch(actor,db.id,{views:[...db.views,view]});return view;});
  tool('update_view','Update a view selected by id or name.',{database_id:identifier,view:identifier,...viewInput},true,input=>{const db=databasePage(pages,actor,input.database_id,true),v=db.views.find(v=>v.id===input.view||v.name===input.view)??fail(404,'View not found.');Object.assign(v,viewFields(db,input));viewSchema.parse(v);pages.patch(actor,db.id,{views:db.views});return v;});
  tool('delete_view','Remove a database view.',{database_id:identifier,view:identifier},true,input=>{const db=databasePage(pages,actor,input.database_id,true),v=db.views.find(v=>v.id===input.view||v.name===input.view)??fail(404,'View not found.');pages.patch(actor,db.id,{views:db.views.filter(x=>x.id!==v.id)});return{ok:true};});
  tool('delete_property','Remove a database property and its row values.',{database_id:identifier,property:identifier},true,input=>{const db=databasePage(pages,actor,input.database_id,true),prop=namedProperty(db,input.property);const rows=pages.list(actor,db.workspaceId).filter(p=>p.parentId===db.id&&p.kind==='row');for(const row of rows)pages.get(actor,row.id,true);for(const row of rows)pages.patch(actor,row.id,{props:{[prop.id]:null}});const views=db.views.map(v=>{v.filters=v.filters.filter(f=>f.propertyId!==prop.id);v.sorts=v.sorts.filter(s=>s.propertyId!==prop.id);v.cardProps=v.cardProps?.filter(p=>p!==prop.id);for(const k of ['groupBy','dateProp','endDateProp']as const)if(v[k]===prop.id)delete v[k];if(v.chart?.groupBy===prop.id||v.chart?.valueProp===prop.id)delete v.chart;return v;});pages.patch(actor,db.id,{schema:db.schema.filter(p=>p.id!==prop.id),views});return{ok:true};});
  tool('list_sticky_notes','Read shared and your private sticky notes.',{workspace_id:identifier},false,input=>dashboard.stickies(actor,input.workspace_id));
  tool('add_sticky_note','Create a sticky note.',{workspace_id:identifier,text,color:z.enum(['yellow','pink','blue','green','purple','orange','gray']).optional()},true,input=>dashboard.add(actor,input.workspace_id,input));
  tool('update_sticky_note','Update a sticky note.',{note_id:identifier,text:text.optional(),color:z.enum(['yellow','pink','blue','green','purple','orange','gray']).optional()},true,input=>dashboard.update(actor,input.note_id,input));
  tool('delete_sticky_note','Delete a sticky note.',{note_id:identifier},true,input=>dashboard.remove(actor,input.note_id));
  tool('get_calendar','Read dated rows and external calendar events.',{workspace_id:identifier,from:text,to:text},false,input=>new Calendars(pages,fetchImpl).events(actor,input.workspace_id,input.from,input.to));
  tool('get_home','Read the home dashboard.',{workspace_id:identifier},false,input=>dashboard.home(actor,input.workspace_id));
  tool('set_home','Set the workspace default dashboard.',{workspace_id:identifier,widgets:widgetsSchema},true,input=>dashboard.setHome(actor,input.workspace_id,input.widgets));
  tool('export_page','Export a page as Markdown, CSV or full fidelity JSON.',{page_id:identifier,format:z.enum(['md','csv','json'])},false,input=>exportPage(pages,actor,input.page_id,input.format));
  tool('attach_image','Download or upload an image and append it to a page.',{page_id:identifier,url:text.optional(),base64:text.optional(),filename:text.optional(),alt:text.optional()},true,async input=>{
    const page=pages.get(actor,input.page_id,true);if(!!input.url===!!input.base64)fail(400,'Supply exactly one image URL or base64 payload.');
    let data:Uint8Array,mime:string;
    if(input.url){const response=await safeDownload(input.url,fetchImpl,20*1024*1024);data=response.data;mime=response.mime.split(';')[0];}
    else{const encoded=input.base64!;const match=/^data:(image\/[^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(encoded);const raw=match?.[2]??encoded;if(!/^[A-Za-z0-9+/=\s]+$/.test(raw))fail(400,'Invalid base64 image.');data=Buffer.from(raw,'base64');mime=match?.[1]??'';}
    const detected=imageMime(data);if(!detected|| (mime&&!mime.startsWith('image/')))fail(400,'Only images can be attached.');mime=detected;
    const file=await storeFile(pages.s,actor,page.workspaceId,data,input.filename??('image.'+mime.split('/')[1]),mime);
    pages.patch(actor,page.id,{content:{type:'doc',content:[...(page.content?.content??[]),{type:'image',attrs:{src:file.url,alt:input.alt??''}}]}});return{url:file.url};
  });
  return server;
}
function imageMime(bytes:Uint8Array):string|undefined {
  const b=Buffer.from(bytes);if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';if(b[0]===255&&b[1]===216&&b[2]===255)return'image/jpeg';if(/^GIF8[79]a/.test(b.subarray(0,6).toString()))return'image/gif';if(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return'image/webp';if(b.subarray(4,12).toString().includes('ftypavif'))return'image/avif';if(/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/.test(b.subarray(0,1024).toString()))return'image/svg+xml';return undefined;
}

export function registerMcp(app: Hono<Env>, pages: Pages, fetchImpl: typeof fetch = fetch): void {
  app.all('/mcp', async c => {
    const authenticated = c.req.header('Authorization') ? credentialActor(pages.s,c) : undefined;
    if (!authenticated) {
      c.header('WWW-Authenticate', `Bearer resource_metadata="${publicUrl(c,'/.well-known/oauth-protected-resource')}"`);
      return c.json({ error: { code: 'unauthorized', message: 'A valid bearer API token is required.' } }, 401);
    }
    const actor: Actor = { ...authenticated, actorType: 'ai', clientId: null };
    const server = buildServer(pages, actor, publicUrl(c),fetchImpl);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(c.req.raw); }
    finally { await server.close(); }
  });
}
