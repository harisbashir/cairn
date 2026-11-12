# Cairn: product and API specification (v0.1)

Cairn is a self-hosted workspace for notes, documents and simple databases, in the spirit of
Notion and AppFlowy, with a first-class MCP server so AI agents can read and write the same
content people do. One Node process serves the REST API, the MCP endpoint and the built web app.

## Stack

- Node 24, TypeScript, ES modules. One `package.json` at the repo root.
- HTTP: Hono + `@hono/node-server`. Validation: zod.
- Storage: SQLite through the built-in `node:sqlite` (`DatabaseSync`), WAL mode, foreign keys on.
  Database file at `$CAIRN_DATA_DIR/cairn.db` (default `./data`). Uploaded files in
  `$CAIRN_DATA_DIR/files/`. Search uses an FTS5 table.
- MCP: `@modelcontextprotocol/sdk`, Streamable HTTP, stateless, at `/mcp`.
- Web: React + Vite, built to `dist/web`, served by the server with an SPA fallback
  (any non-`/api`, non-`/mcp`, non-`/files` GET returns `index.html`).
- Shared code in `shared/` is imported by both server and web. `shared/types.ts` is the
  contract and must not be changed by the backend work without saying so.

Layout:

```
shared/types.ts        contract (exists)
shared/query.ts        applyView(rows, view, schema) filter + sort, used by web and MCP
shared/markdown.ts     docToMarkdown(doc), markdownToDoc(md)
server/src/main.ts     starts the server (PORT, default 8080)
server/src/app.ts      createApp({ dataDir }) returns the Hono app (used by tests)
server/src/db.ts       schema + migrations (PRAGMA user_version)
server/src/...         routes, auth, mcp, events
server/test/*.test.ts  vitest, each test uses a temp data dir
web/                   React app (not part of the backend work)
```

Environment: `PORT` (8080), `CAIRN_DATA_DIR` (`./data`), `CAIRN_PUBLIC_URL` (used in invite and
share links and MCP instructions; default derived from the request), `CAIRN_SECURE_COOKIES`
(`1` to set the `Secure` flag).

## Conventions

- JSON in, JSON out. Errors: HTTP status + `{ "error": { "code", "message" } }` with a
  human-readable message suitable for showing to the user. Codes: `unauthorized` 401,
  `forbidden` 403, `not_found` 404, `invalid` 400, `conflict` 409.
- Ids: 16+ character URL-safe random strings.
- Auth: session cookie `cairn_session` (HttpOnly, SameSite=Lax, 30 days, random 32-byte token,
  only its SHA-256 stored). Passwords: `scrypt` from `node:crypto` with a per-user salt; minimum
  8 characters. Mutating `/api` requests must carry the header `X-Cairn-Client: <clientId>`
  (any non-empty string, the browser tab's id); reject otherwise with 400. This doubles as CSRF
  protection, and the id is echoed in live events so a tab can ignore its own changes.
- A disabled user cannot log in, and their sessions and tokens stop working.
- Roles per workspace: `owner` > `admin` > `member` > `viewer`. Viewers read only. Members
  create and edit pages. Admins and owners manage members, invites and workspace settings.
  Only an owner can delete the workspace or change another owner. A workspace always keeps at
  least one owner. Instance administrators (`User.isAdmin`) can use `/api/admin/*` but get no
  implicit access to workspace content.
- Private pages (`visibility: 'private'`) and all their descendants are visible only to their
  creator. Everything else in a workspace is visible to all its members. Every page read or
  write checks membership and visibility; return 404 rather than 403 for pages the user may
  not see.
- Trash: `deletedAt` set on the page; descendants are hidden with it (computed, not stamped).
  Trashed pages are excluded from tree, rows, search and recent.
- Ordering: `position` is a float. New pages go last among their siblings unless `afterId` is
  given. Moving computes a position between neighbours.
- Every mutation of a page writes an `activity` row and emits a live event to the workspace.
- Versions: on PATCH of `content` or `title`, snapshot the *previous* state into
  `page_versions` if the latest snapshot for that page is older than 10 minutes or was made by
  a different actor. Keep at most 50 versions per page.

## REST API

All under `/api`. Unless marked public, a session is required.

### Session and account

| Method and path | Body | Returns |
| --- | --- | --- |
| GET `/api/bootstrap` (public) | | `Bootstrap` (`user: null` when signed out) |
| POST `/api/auth/signup` (public) | `{ email, name, password, inviteToken? }` | `Bootstrap`. Allowed when no user exists (that user becomes administrator and gets a first workspace named "<name>'s workspace" with a welcome page), or `allowSignup` is on, or the invite token is valid (then the invite is accepted too). A user who signs up without an invite also gets a personal workspace. |
| POST `/api/auth/login` (public) | `{ email, password }` | `Bootstrap`. Same error for unknown email and wrong password. Rate limit: 10 failures per email per 15 minutes. |
| POST `/api/auth/logout` | | `{ ok: true }` |
| PATCH `/api/me` | `{ name?, color?, currentPassword?, newPassword? }` | `User` |
| GET `/api/tokens` | | `ApiToken[]` |
| POST `/api/tokens` | `{ name, access, workspaceId? }` | `{ token: ApiToken, secret: string }`. Secret format `cairn_` + 40 random chars, shown once, stored as SHA-256. |
| DELETE `/api/tokens/:id` | | `{ ok: true }` |

### Workspaces and members

| Method and path | Body | Returns |
| --- | --- | --- |
| POST `/api/workspaces` | `{ name, icon?, color? }` | `WorkspaceSummary` (creator is owner; seeded with a "Getting started" page) |
| PATCH `/api/workspaces/:wid` | `{ name?, icon?, color? }` | `WorkspaceSummary` |
| DELETE `/api/workspaces/:wid` | | `{ ok: true }` (owner only) |
| GET `/api/workspaces/:wid/members` | | `Member[]` |
| PATCH `/api/workspaces/:wid/members/:userId` | `{ role }` | `Member` |
| DELETE `/api/workspaces/:wid/members/:userId` | | `{ ok: true }` (admins remove others; anyone can remove themselves, i.e. leave) |
| GET `/api/workspaces/:wid/invites` | | `Invite[]` (pending only) |
| POST `/api/workspaces/:wid/invites` | `{ email?, role }` | `Invite` (expires in 14 days) |
| DELETE `/api/workspaces/:wid/invites/:id` | | `{ ok: true }` |
| GET `/api/invites/:token` (public) | | `{ workspaceName, workspaceIcon, inviterName, role, email }` or 404 if expired/used |
| POST `/api/invites/:token/accept` | | `WorkspaceSummary` |
| GET `/api/workspaces/:wid/users` | | `{ id, name, color }[]` members, for person properties |

### Pages

| Method and path | Body | Returns |
| --- | --- | --- |
| GET `/api/workspaces/:wid/tree` | | `Tree` |
| POST `/api/workspaces/:wid/pages` | `{ parentId?, kind?, title?, icon?, content?, props?, schema?, views?, visibility?, afterId? }` | `Page`. `kind: 'row'` requires `parentId` of a database. A new database with no schema gets one `status` property ("Status": Not started/In progress/Done) and one default table view. |
| GET `/api/pages/:id` | | `Page` with `breadcrumbs`, `favorite`, `shareToken`, `canEdit`, and `parentSchema` for rows |
| PATCH `/api/pages/:id` | any of `{ title, icon, cover, content, props, schema, views, visibility }` | `Page`. `props` is merged key by key (a `null` value clears the key). `schema` and `views` replace. |
| POST `/api/pages/:id/move` | `{ parentId: string or null, afterId?: string or null }` | `Page`. Reject moving a page into itself or a descendant, and moving rows out of databases. |
| POST `/api/pages/:id/duplicate` | | `Page` (deep copy, title + " copy", placed after the original) |
| DELETE `/api/pages/:id` | | `{ ok: true }` moves to trash. With `?permanent=1` deletes for good (page must already be in trash). |
| POST `/api/pages/:id/restore` | | `Page` (if its parent is gone or trashed, restore to the workspace root) |
| GET `/api/pages/:id/rows` | | `Row[]` (all non-trashed rows of a database, by position) |
| PUT / DELETE `/api/pages/:id/favorite` | | `{ ok: true }` |
| GET `/api/pages/:id/versions` | | `PageVersion[]` newest first |
| POST `/api/pages/:id/versions/:versionId/restore` | | `Page` (snapshots the current state first) |
| POST `/api/pages/:id/share` | | `{ token }` creates or returns the public read-only link token |
| DELETE `/api/pages/:id/share` | | `{ ok: true }` |
| GET `/api/public/:token` (public) | | `{ page: Page, rows: Row[] }` (rows only for databases; no breadcrumbs) |
| GET `/api/workspaces/:wid/trash` | | `TrashItem[]` (top-most trashed pages only) |
| GET `/api/workspaces/:wid/search?q=&limit=` | | `SearchHit[]` (prefix matching on the last term; titles weighted above body; empty `q` returns `[]`) |
| GET `/api/workspaces/:wid/recent?limit=` | | `RecentPage[]` |
| GET `/api/workspaces/:wid/activity?limit=&before=` | | `Activity[]` newest first |
| GET `/api/workspaces/:wid/events` | | Server-sent events stream of `LiveEvent` as `data: <json>`; a `ping` every 25 s |
| POST `/api/workspaces/:wid/files` | multipart `file` (max 20 MB) | `{ url }` such as `/files/<id>/<name>` |
| GET `/files/:id/:name` | | The file. Requires a session with access to the workspace, or `?share=<token>` of a shared page in that workspace. |

The search index (FTS5) holds title + plain text of `content` + text of row props, and is kept
in sync on every page write.

### Instance administration (requires `isAdmin`)

| Method and path | Body | Returns |
| --- | --- | --- |
| GET `/api/admin/overview` | | `AdminOverview` |
| GET `/api/admin/users` | | `(User & { workspaces: number })[]` |
| POST `/api/admin/users` | `{ email, name, password, isAdmin? }` | `User` |
| PATCH `/api/admin/users/:id` | `{ name?, isAdmin?, disabled?, password? }` | `User`. An administrator cannot disable or demote themselves; the last administrator cannot be demoted. |
| DELETE `/api/admin/users/:id` | | `{ ok: true }`. Refuse while the user is the sole owner of a workspace that has other members; workspaces they own alone are deleted. |
| GET `/api/admin/workspaces` | | `AdminWorkspace[]` |
| DELETE `/api/admin/workspaces/:wid` | | `{ ok: true }` |
| GET / PATCH `/api/admin/settings` | `{ instanceName?, allowSignup? }` | `AdminSettings` |

## MCP server

Endpoint `/mcp` (POST, plus GET/DELETE answered per the SDK's stateless transport).
Authentication: `Authorization: Bearer cairn_...` (an API token). 401 with a
`WWW-Authenticate: Bearer` header otherwise. A `read` token cannot call write tools (they are not
listed and calls are refused). A token scoped to one workspace sees only that workspace.
Changes made through MCP are recorded with `actorType: 'ai'` and emit live events like any other.

Server name `cairn`, with `instructions` that explain the model in a few sentences: workspaces
contain pages; pages nest; a database is a page whose children are rows; rows have typed
properties and their own page body; content is exchanged as Markdown.

Tools (zod input schemas, concise descriptions, results as readable text with ids; errors as
`isError` results with a clear message):

- `list_workspaces()`
- `search(query, workspace_id?, limit?)`
- `list_pages(workspace_id, parent_id?)` children of a page, or the workspace root
- `get_page(page_id)` title, path, properties (by name, with option names resolved) and body as Markdown; for a database, its schema and views
- `create_page(workspace_id, title, parent_id?, markdown?, icon?)`
- `update_page(page_id, title?, icon?, markdown?)` replaces the body when `markdown` is given
- `append_to_page(page_id, markdown)`
- `move_page(page_id, parent_id?)`
- `delete_page(page_id)` to trash
- `get_database(database_id)` schema (property names, types, option names) and views
- `create_database(workspace_id, title, properties[], parent_id?)` each property `{ name, type, options? }`
- `update_database(database_id, title?, add_properties?, rename_properties?, add_options?)`
- `query_database(database_id, filters?, sorts?, view?, limit?)` filters and sorts by property *name*; values by option *name*; returns rows with properties resolved to names
- `create_row(database_id, title, properties?, markdown?)` properties keyed by property name; select values by option name (unknown option names are created automatically)
- `update_row(row_id, title?, properties?, markdown?)`
- `recent_activity(workspace_id, limit?)`

## Shared modules

`shared/query.ts`

```ts
export function applyView<T extends { title: string; props: Props; createdAt: string; updatedAt: string; position: number }>(
  rows: T[], view: Pick<View, 'filters' | 'sorts'>, schema: Property[]): T[]
```

Filters are AND-ed. Text operators are case-insensitive. `select`/`status` compare option ids
(`eq`, `neq`); `multi_select`, `person` and `relation` use `contains`/`not_contains` with one id.
Dates compare lexically on the `YYYY-MM-DD` prefix. With no sorts, order is by `position`.
Select-type sorts follow the option order in the schema. Unknown property ids are ignored.

`shared/markdown.ts`

```ts
export function docToMarkdown(doc: DocNode | null): string
export function markdownToDoc(markdown: string): DocNode
export function docToPlainText(doc: DocNode | null): string
```

Tiptap node types in use: `doc`, `paragraph`, `heading` (attrs.level 1-3), `bulletList`,
`orderedList`, `listItem`, `taskList`, `taskItem` (attrs.checked), `blockquote`, `codeBlock`
(attrs.language), `horizontalRule`, `hardBreak`, `image` (attrs.src, alt), `callout`
(attrs.emoji; content is blocks; Markdown form `> [!NOTE] ...` style blockquote starting with
the emoji), `pageLink` (inline atom, attrs.pageId, attrs.title; Markdown form
`[title](cairn://page/<id>)`), `text` with marks `bold`, `italic`, `strike`, `code`, `link`
(attrs.href), `highlight`. Round-tripping doc → Markdown → doc must preserve structure for these.
Use `marked`'s lexer for parsing.

## Tests

vitest, run with `npm test`. Cover at least: sign-up/first-admin/login/logout; role and
private-page permission checks; page CRUD, move, trash/restore, duplicate; database rows and
`applyView`; search; versions; invites; tokens; admin endpoints; Markdown round trips; and the
MCP tools end to end through the app (in-process requests with a bearer token).
