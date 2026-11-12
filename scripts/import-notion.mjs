#!/usr/bin/env node
// Copies Notion data sources (databases) into a Cairn workspace. Notion is only read, never changed.
//
//   NOTION_TOKEN=...  CAIRN_URL=http://host  CAIRN_EMAIL=...  CAIRN_PASSWORD=... \
//   node scripts/import-notion.mjs --workspace "Projects HQ" --parent "Projects HQ" "🗂️" <dataSourceId> [<dataSourceId> ...]
//
// --workspace  name of an existing Cairn workspace (created when missing)
// --parent     optional title + icon of a page to hold the imported databases

const NOTION = 'https://api.notion.com/v1';
const env = (k) => process.env[k] || (console.error(`Missing ${k}`), process.exit(1));
const notionToken = env('NOTION_TOKEN');
const cairnUrl = env('CAIRN_URL').replace(/\/$/, '');

const args = process.argv.slice(2);
let workspaceName = 'Imported from Notion';
let parentTitle = '';
let parentIcon = '';
const sources = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workspace') workspaceName = args[++i];
  else if (args[i] === '--parent') { parentTitle = args[++i]; parentIcon = args[++i] ?? ''; }
  else sources.push(args[i]);
}
if (!sources.length) { console.error('Give at least one Notion data source id.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function notion(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NOTION + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
    });
    if (res.status === 429 && attempt < 6) { await sleep(1000 * (Number(res.headers.get('retry-after')) || 2)); continue; }
    if (!res.ok) throw new Error(`Notion ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}
async function notionAll(method, path, body = {}) {
  const out = [];
  let cursor;
  do {
    const page = method === 'GET'
      ? await notion('GET', `${path}${path.includes('?') ? '&' : '?'}page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`)
      : await notion('POST', path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

let cookie = '';
async function cairn(method, path, body) {
  const res = await fetch(cairnUrl + path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', 'X-Cairn-Client': 'notion-import', ...(cookie ? { Cookie: cookie } : {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Cairn ${method} ${path}: ${res.status} ${data?.error?.message ?? ''}`);
  return data;
}

// ---------- Notion → Cairn conversion ----------
const COLOR = { default: 'gray', gray: 'gray', brown: 'brown', orange: 'orange', yellow: 'yellow', green: 'green', blue: 'blue', purple: 'purple', pink: 'pink', red: 'red' };
const id8 = () => Math.random().toString(36).slice(2, 10);
const plain = (rich) => (rich ?? []).map((r) => r.plain_text).join('');

function inline(rich) {
  return (rich ?? []).filter((r) => r.plain_text).map((r) => {
    const marks = [];
    const a = r.annotations ?? {};
    if (a.bold) marks.push({ type: 'bold' });
    if (a.italic) marks.push({ type: 'italic' });
    if (a.strikethrough) marks.push({ type: 'strike' });
    if (a.code) marks.push({ type: 'code' });
    if (r.href && !a.code) marks.push({ type: 'link', attrs: { href: r.href } });
    return { type: 'text', text: r.plain_text, ...(marks.length ? { marks } : {}) };
  });
}
const para = (rich) => { const c = inline(rich); return c.length ? { type: 'paragraph', content: c } : { type: 'paragraph' }; };

async function blocksToDoc(blockId, depth = 0) {
  const blocks = await notionAll('GET', `/blocks/${blockId}/children`);
  const out = [];
  const pushList = (type, item) => {
    const last = out[out.length - 1];
    if (last?.type === type) last.content.push(item); else out.push({ type, content: [item] });
  };
  for (const b of blocks) {
    const d = b[b.type] ?? {};
    const kids = b.has_children && depth < 4 && !['child_page', 'child_database'].includes(b.type) ? await blocksToDoc(b.id, depth + 1) : [];
    switch (b.type) {
      case 'paragraph': out.push(para(d.rich_text), ...kids); break;
      case 'heading_1': case 'heading_2': case 'heading_3': {
        const c = inline(d.rich_text);
        out.push({ type: 'heading', attrs: { level: Number(b.type.slice(-1)) }, ...(c.length ? { content: c } : {}) }, ...kids);
        break;
      }
      case 'bulleted_list_item': pushList('bulletList', { type: 'listItem', content: [para(d.rich_text), ...kids] }); break;
      case 'numbered_list_item': pushList('orderedList', { type: 'listItem', content: [para(d.rich_text), ...kids] }); break;
      case 'to_do': pushList('taskList', { type: 'taskItem', attrs: { checked: !!d.checked }, content: [para(d.rich_text), ...kids] }); break;
      case 'toggle': out.push(para(d.rich_text), ...kids); break;
      case 'quote': out.push({ type: 'blockquote', content: [para(d.rich_text), ...kids] }); break;
      case 'callout': out.push({ type: 'callout', attrs: { emoji: d.icon?.emoji ?? '💡' }, content: [para(d.rich_text), ...kids] }); break;
      case 'code': out.push({ type: 'codeBlock', attrs: { language: d.language ?? null }, content: plain(d.rich_text) ? [{ type: 'text', text: plain(d.rich_text) }] : undefined }); break;
      case 'divider': out.push({ type: 'horizontalRule' }); break;
      case 'bookmark': case 'embed': case 'link_preview':
        if (d.url) out.push({ type: 'paragraph', content: [{ type: 'text', text: d.url, marks: [{ type: 'link', attrs: { href: d.url } }] }] });
        break;
      case 'child_page': out.push({ type: 'paragraph', content: [{ type: 'text', text: `📄 ${d.title} (sub-page in Notion, not imported)` }] }); break;
      default: if (d.rich_text) out.push(para(d.rich_text)); out.push(...kids);
    }
  }
  return out;
}

function mapSchema(nProps) {
  const schema = [];
  const byName = {}; // notion property name -> { prop, optionId(name), kind }
  let titleName = 'Name';
  for (const [name, p] of Object.entries(nProps)) {
    if (p.type === 'title') { titleName = name; continue; }
    const prop = { id: id8(), name };
    const opts = (list) => (list ?? []).map((o) => ({ id: id8(), name: o.name, color: COLOR[o.color] ?? 'gray' }));
    switch (p.type) {
      case 'rich_text': case 'email': case 'phone_number': case 'formula': case 'rollup': case 'people': case 'created_by': case 'last_edited_by': case 'unique_id': prop.type = 'text'; break;
      case 'number': prop.type = 'number'; break;
      case 'select': prop.type = 'select'; prop.options = opts(p.select.options); break;
      case 'multi_select': prop.type = 'multi_select'; prop.options = opts(p.multi_select.options); break;
      case 'status': prop.type = 'status'; prop.options = opts(p.status.options); break;
      case 'date': case 'created_time': case 'last_edited_time': prop.type = 'date'; break;
      case 'checkbox': prop.type = 'checkbox'; break;
      case 'url': prop.type = 'url'; break;
      case 'relation': prop.type = 'relation'; prop.notionTarget = p.relation.data_source_id ?? p.relation.database_id; break;
      default: continue; // files, buttons, etc.
    }
    schema.push(prop);
    byName[name] = { prop, kind: p.type };
  }
  return { schema, byName, titleName };
}

function mapValue(v, { prop, kind }) {
  const opt = (name) => prop.options?.find((o) => o.name === name)?.id ?? null;
  switch (kind) {
    case 'rich_text': return plain(v.rich_text) || null;
    case 'email': return v.email; case 'phone_number': return v.phone_number;
    case 'number': return v.number;
    case 'select': return v.select ? opt(v.select.name) : null;
    case 'status': return v.status ? opt(v.status.name) : null;
    case 'multi_select': return v.multi_select.map((o) => opt(o.name)).filter(Boolean);
    case 'date': return v.date?.start ?? null;
    case 'created_time': return v.created_time; case 'last_edited_time': return v.last_edited_time;
    case 'checkbox': return v.checkbox;
    case 'url': return v.url;
    case 'people': return v.people.map((p) => p.name).filter(Boolean).join(', ') || null;
    case 'created_by': return v.created_by?.name ?? null; case 'last_edited_by': return v.last_edited_by?.name ?? null;
    case 'unique_id': return v.unique_id ? `${v.unique_id.prefix ? v.unique_id.prefix + '-' : ''}${v.unique_id.number}` : null;
    case 'formula': { const f = v.formula; const x = f?.[f.type]; return x == null ? null : typeof x === 'object' ? x.start ?? null : String(x); }
    case 'rollup': { const r = v.rollup; return r?.type === 'number' ? String(r.number ?? '') || null : r?.type === 'array' ? r.array.map((a) => plain(a.title ?? a.rich_text) || a.number || '').filter(Boolean).join(', ') || null : null; }
    case 'relation': return { relation: v.relation.map((r) => r.id) };
    default: return null;
  }
}

// ---------- Run ----------
await cairn('POST', '/api/auth/login', { email: env('CAIRN_EMAIL'), password: env('CAIRN_PASSWORD') });
const boot = await cairn('GET', '/api/bootstrap');
const ws = boot.workspaces.find((w) => w.name === workspaceName) ?? await cairn('POST', '/api/workspaces', { name: workspaceName, icon: '🗂️' });
console.log(`Workspace: ${ws.name}`);
let parentId = null;
if (parentTitle) parentId = (await cairn('POST', `/api/workspaces/${ws.id}/pages`, { title: parentTitle, icon: parentIcon })).id;

const dbs = []; // { dsId, cairnId, schema, byName, rows: [{ cairnId, relations: { propId: [notionIds] } }] }
const rowMap = new Map(); // notion page id -> cairn row id
const norm = (id) => id.replace(/-/g, '');

for (const dsId of sources) {
  const ds = await notion('GET', `/data_sources/${dsId}`);
  const title = plain(ds.title) || 'Untitled';
  const { schema, byName, titleName } = mapSchema(ds.properties);
  const db = await cairn('POST', `/api/workspaces/${ws.id}/pages`, {
    kind: 'database', parentId, title, icon: ds.icon?.emoji ?? '',
    schema: schema.map(({ notionTarget, ...p }) => p),
    views: [{ id: id8(), name: 'Table', type: 'table', filters: [], sorts: [] }],
  });
  const entry = { dsId: norm(dsId), cairnId: db.id, schema, byName, rows: [], title };
  dbs.push(entry);
  const pages = await notionAll('POST', `/data_sources/${dsId}/query`);
  console.log(`${title}: ${pages.length} rows`);
  for (const p of pages) {
    if (p.archived || p.in_trash) continue;
    const props = {};
    const relations = {};
    for (const [name, v] of Object.entries(p.properties)) {
      if (name === titleName || !byName[name]) continue;
      const val = mapValue(v, byName[name]);
      if (val && typeof val === 'object' && !Array.isArray(val)) relations[byName[name].prop.id] = val.relation;
      else if (val !== null && val !== undefined && val !== '' && !(Array.isArray(val) && !val.length)) props[byName[name].prop.id] = val;
    }
    let content = [];
    try { content = await blocksToDoc(p.id); } catch (err) { console.warn(`  body skipped for "${plain(p.properties[titleName]?.title)}": ${err.message}`); }
    const row = await cairn('POST', `/api/workspaces/${ws.id}/pages`, {
      kind: 'row', parentId: db.id, title: plain(p.properties[titleName]?.title), icon: p.icon?.emoji ?? '', props,
      ...(content.length ? { content: { type: 'doc', content } } : {}),
    });
    rowMap.set(norm(p.id), row.id);
    entry.rows.push({ cairnId: row.id, relations });
  }
}

// Second pass: point relations at the imported databases and rows.
for (const db of dbs) {
  let changed = false;
  for (const p of db.schema) {
    if (p.type !== 'relation') continue;
    const target = dbs.find((d) => d.dsId === norm(p.notionTarget ?? ''));
    if (target) { p.relationDatabaseId = target.cairnId; changed = true; }
  }
  if (changed) await cairn('PATCH', `/api/pages/${db.cairnId}`, { schema: db.schema.map(({ notionTarget, ...p }) => p) });
  for (const row of db.rows) {
    const props = {};
    for (const [propId, ids] of Object.entries(row.relations)) {
      const mapped = ids.map((i) => rowMap.get(norm(i))).filter(Boolean);
      if (mapped.length) props[propId] = mapped;
    }
    if (Object.keys(props).length) await cairn('PATCH', `/api/pages/${row.cairnId}`, { props });
  }
}
console.log('Done.');
