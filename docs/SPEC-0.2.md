# Cairn v0.2 backend additions

Everything in `docs/SPEC.md` still holds. This document adds to it. `shared/types.ts` has already
been extended and is the contract: return exactly those shapes. Existing stored data must keep
working: add migrations (`PRAGMA user_version`) and default any new field when it is missing.

## 1. Contract changes to existing endpoints

- `User.prefs` (`UserPrefs`), default `{ theme: 'system', accent: 'blue' }`. `PATCH /api/me` accepts `{ prefs }` (partial merge, validated).
- `View` gained optional fields (see types). Validation must accept all `ViewType` values and the new fields.
- `Row` gained `cover`, `preview`, `createdBy`, `createdByName`, `updatedByType`. `cover` = the row page's `cover`, else the `src` of the first `image` node in its body, else `''`. `preview` = first 200 characters of `docToPlainText(content)`.
- Reordering rows: `POST /api/pages/:id/move` with the same `parentId` and an `afterId` (or `afterId: null` for first) reorders a row inside its database.
- Search: rebuild the FTS index once in the migration (old entries contain raw ids).
- New page default title is `''` (not "Untitled") when `title` is omitted.

## 2. Bearer authentication for REST (mobile and third-party apps)

- Every `/api` endpoint also accepts `Authorization: Bearer <secret>` where the secret is either
  an API token (`cairn_…`, honouring its `access` and workspace scope: a `read` token gets 403 on
  any mutating request) or a session token, or an OAuth access token (section 9).
- With a bearer credential the `X-Cairn-Client` header is not required.
- `POST /api/auth/login` and `/api/auth/signup` accept `"token": true` in the body; the response
  then also contains `sessionToken` (the same secret the cookie would carry) and no cookie is set.
- `POST /api/auth/logout` with a bearer session token invalidates it.
- Mount the whole API a second time under `/api/v1` (identical behaviour). `/api/v1` is the stable
  prefix documented for apps.
- `GET /api/openapi.json` (public): an OpenAPI 3.1 document describing every endpoint (paths,
  methods, auth, request bodies and response schema names; schemas for the main types). Keep the
  source in `server/src/openapi.ts`.
- `GET /api/health` (public) → `{ ok: true, version }`.
- CORS: no cross-origin access by default. If `CAIRN_CORS_ORIGINS` (comma-separated) is set, allow
  those origins for bearer-authenticated requests.

## 3. Home dashboard and sticky notes

| Method and path | Body | Returns |
| --- | --- | --- |
| GET `/api/workspaces/:wid/home` | | `HomeLayout` (the user's personal layout if they have one, else the workspace default; a workspace with none stored gets the built-in default: welcome, recent, stickies, activity) |
| PUT `/api/workspaces/:wid/home?scope=personal` or `=workspace` | `{ widgets: Widget[] }` | `HomeLayout`. `workspace` scope needs owner/admin. Validate types, sizes, max 30 widgets, config size ≤ 20 KB each. |
| DELETE `/api/workspaces/:wid/home?scope=personal` | | `HomeLayout` (back to the workspace default) |
| GET `/api/workspaces/:wid/stickies` | | `Sticky[]` by position (workspace-visible ones plus the caller's private ones) |
| POST `/api/workspaces/:wid/stickies` | `{ text?, color?, visibility? }` | `Sticky` (new notes go first) |
| PATCH `/api/stickies/:id` | `{ text?, color?, visibility?, afterId? }` | `Sticky`. Members can edit workspace-visible notes; only the author can edit a private one or change visibility. Max 2000 characters. |
| DELETE `/api/stickies/:id` | | `{ ok: true }` |
| GET `/api/workspaces/:wid/stats` | | `{ pages, databases, rows, members, editsThisWeek, aiEditsThisWeek }` |

Sticky and home changes emit a live event. Add to `LiveEvent` handling without changing the type
union's existing members: emit `{ type: 'members' }`-style lightweight events named
`{ type: 'home' }` and `{ type: 'stickies' }` (extend the union in `shared/types.ts` for these two
only).

## 4. Calendars

- `GET /api/workspaces/:wid/calendars` → `ExternalCalendar[]`; `POST` `{ name, url, color? }` (owner/admin/member; `webcal://` is rewritten to `https://`; only http/https); `DELETE /api/workspaces/:wid/calendars/:id`.
- Fetch external ICS with a 10 s timeout and a 5 MB cap, cache per calendar for 15 minutes, record `lastSyncedAt` / `lastError`. Refuse URLs that resolve to loopback or link-local addresses unless `CAIRN_ALLOW_PRIVATE_ICS=1` (private LAN ranges are allowed, since self-hosters use Nextcloud at home).
- ICS parsing in `server/src/ics.ts` (no dependency): line unfolding, `VEVENT` with `SUMMARY`, `DTSTART`/`DTEND` (date, UTC date-time, `TZID` date-time treated via `Intl` offset lookup), `LOCATION`, `UID`, `RRULE` with `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` (weekly), and `EXDATE`. Expand recurrences only inside the requested window.
- `GET /api/workspaces/:wid/calendar-events?from=YYYY-MM-DD&to=YYYY-MM-DD` → `CalendarEvent[]` sorted by start: external events plus one event per non-trashed row, per `date` property with a value, in every database the caller can see (`title` = row title, `calendarName` = database title, colour stable per database). Window max 400 days.
- Outgoing feed: `GET /api/workspaces/:wid/calendar-feed` → `CalendarFeed`; `POST` creates (or returns) the caller's private feed token; `DELETE` revokes it. `GET /cal/:token.ics` (public, `text/calendar`) serves the row events of that workspace as the token's owner sees them (all-day events for date-only values; `URL` pointing at the page; stable `UID`s). This is what Google Calendar / Apple Calendar / Outlook subscribe to.

## 5. Import and export

Use `fflate` (installed) for zip.

- `GET /api/pages/:id/export?format=md|csv|json`: `md` for pages and rows (front matter with title and properties by name), `csv` for databases (header = Name + property names; option names, ISO dates, `;`-joined multi values; relation = titles), `json` = full fidelity subtree.
- `GET /api/workspaces/:wid/export` → `application/zip`: `cairn.json` (full fidelity: all pages the caller can see, schemas, views, stickies, home layout) plus a readable tree: pages as `Title.md`, child pages in a folder named after the parent, databases as `Title.csv` plus a folder of row `.md` files, and `files/` with uploaded files referenced by the exported pages.
- `POST /api/workspaces/:wid/import` (multipart `file`, optional `parentId`): accepts
  - `.md` / `.markdown` / `.txt` → one page (first `# heading` or filename becomes the title);
  - `.csv` → a database (first column = Name; column types inferred: number, checkbox, date, url, select when ≤ 12 distinct short values, multi_select for `,`/`;` lists of repeated values, else text);
  - `.json` → a Cairn `json` export;
  - `.zip` → a Cairn export (uses `cairn.json`) or any zip of `.md` and `.csv` files, including a Notion "Markdown & CSV" export: strip Notion's 32-hex id suffixes from names, rebuild folder nesting as page nesting, turn each `.csv` into a database and attach same-named folder `.md` files as row bodies by title, rewrite relative image links to uploaded files.
  Returns a `Job` (run asynchronously; `result.pageIds` = top-level pages created).
- `GET /api/jobs/:id` → `Job` (only its creator). Jobs live in memory and are kept for an hour.
- Notion API (version `2025-09-03`, base `https://api.notion.com/v1`). The token is supplied per request and never stored or logged.
  - `POST /api/workspaces/:wid/notion/sources` `{ token }` → `NotionSource[]` (search for data sources and top-level pages the integration can access; paginate).
  - `POST /api/workspaces/:wid/notion/import` `{ token, sourceIds: string[], parentId? }` → `Job`. Port the logic of `scripts/import-notion.mjs` into `server/src/notion.ts` (schema mapping, rows, block bodies, two-pass relations, 429 retry) and extend it: pages (non-database) import as pages with their child pages, images are downloaded into Cairn file storage, progress is reported per database.
  - `POST /api/workspaces/:wid/notion/export` `{ token, pageId, notionParentPageId }` → `Job`. Creates in Notion, under the given Notion page: for a Cairn database, a database with mapped properties (relations and people become text) and one Notion page per row with its body as blocks; for a Cairn page, a page with its body as blocks and child pages recursively. `result.url` = the created Notion page/database URL. Respect Notion limits (100 blocks per request, 2000 characters per rich-text item, ~3 requests/second).
  - Keep `scripts/import-notion.mjs` working, or replace it with a thin wrapper around the new module.

## 6. Backups (instance administrators)

- A backup is one zip named `cairn-backup-YYYYMMDD-HHmmss.zip` containing a consistent database snapshot (`VACUUM INTO` a temp file) and the `files/` directory, plus `manifest.json` (version, createdAt, counts). Built on disk, streamed, never fully in memory for the files part if avoidable.
- `GET /api/admin/backups/settings` → `BackupSettings`; `PUT` same shape (secrets write-only: an empty secret on write keeps the stored one). Stored in the database.
- Destinations: `local` (`$CAIRN_DATA_DIR/backups/`), `webdav` (HTTP `PUT` with basic auth to `url` + filename; `MKCOL` the folder if missing; retention via `PROPFIND` + `DELETE` of older `cairn-backup-*.zip`), `rclone` (write the supplied config to a 0600 temp file and run `rclone copyto` / `rclone lsf` / `rclone deletefile` with `--config`; `rcloneAvailable` reflects whether the binary exists; arguments passed as an array, never through a shell).
- `POST /api/admin/backups/run` → `BackupRun` (starts it; poll the list). `GET /api/admin/backups` → `BackupRun[]` newest first (keep the last 50 records). `GET /api/admin/backups/:id/download` → the zip when a local copy exists. `POST /api/admin/backups/test` `{ destination }` → `{ ok, message }` (writes and removes a small test file).
- Scheduler: checks once a minute; runs when due per `frequency`/`hour`/`weekday`; never two runs at once; applies `keep` per destination after a successful upload. With no `local` destination configured, the temp zip is deleted after upload.
- Restore and admin CLI, `server/src/cli.ts`, runnable as `node dist/server/src/cli.js <command>` (and `npm run cli -- <command>`): `create-user --email --name --password [--admin]`, `reset-password --email --password`, `backup [--out file]`, `restore <file>` (refuses while the server holds the database unless `--force`; keeps the previous data as `cairn.db.before-restore`), `reindex`.

## 7. Files and images

- Uploads already exist. Additionally: `GET /files/:id/:name?w=<px>` may return the original (no resizing needed); set `Cache-Control: private, max-age=31536000, immutable`; send correct `Content-Type` from the stored mime and `Content-Disposition: inline` only for images, PDF, audio and video, `attachment` for everything else; `X-Content-Type-Options: nosniff`; SVG is served as attachment.
- `GET /api/workspaces/:wid/files` → `{ id, name, url, mime, size, createdAt, createdByName }[]` newest first; `DELETE /api/files/:id` (uploader or admin).
- Per-file limit stays 20 MB; reject when the workspace exceeds `CAIRN_MAX_STORAGE_MB` (default unlimited).

## 8. MCP additions

Keep all existing tools. Add tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, a `title`) to every tool. New tools:

- `whoami()` the user, token access level and reachable workspaces
- `list_databases(workspace_id)` id, title, path, property names and row count
- `list_trash(workspace_id)`, `restore_page(page_id)`
- `duplicate_page(page_id)`
- `add_view(database_id, name, type, group_by?, date_property?, end_date_property?, card_properties?, filters?, sorts?, chart?)` and `update_view(database_id, view, …same)` / `delete_view(database_id, view)`; properties by name
- `delete_property(database_id, property)`
- `list_sticky_notes(workspace_id)`, `add_sticky_note(workspace_id, text, color?)`, `update_sticky_note(note_id, text?, color?)`, `delete_sticky_note(note_id)`
- `get_calendar(workspace_id, from, to)` events as in section 4
- `attach_image(page_id, url? , base64?, filename?, alt?)` stores the image in Cairn (downloads `url` with the same SSRF guard as ICS, 20 MB cap, images only) and appends it to the page
- `get_home(workspace_id)` and `set_home(workspace_id, widgets)` (workspace default; needs owner/admin)
- `export_page(page_id, format)` md / csv / json as text

`query_database` gains `offset` and returns `total`. `get_page` gains `include_children` (list of child pages with ids). Read-only tokens must not see or call any mutating tool.

## 9. OAuth 2.1 for MCP clients and apps

So that clients which cannot send a static header (claude.ai connectors, ChatGPT, mobile apps) can connect. Implement in `server/src/oauth.ts`:

- `GET /.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) → resource metadata naming this server as its authorization server.
- `GET /.well-known/oauth-authorization-server` → metadata: `authorization_endpoint` `/oauth/authorize`, `token_endpoint` `/oauth/token`, `registration_endpoint` `/oauth/register`, `code_challenge_methods_supported: ['S256']`, grant types `authorization_code` and `refresh_token`, `token_endpoint_auth_methods_supported: ['none']`, scopes `read`, `write`.
- `POST /oauth/register` (RFC 7591 dynamic registration, public clients): store `client_name`, `redirect_uris` (https, or http on localhost/127.0.0.1, or a custom app scheme). Rate-limit registrations.
- `GET /oauth/authorize` validates `client_id`, `redirect_uri` (exact match), `response_type=code`, `code_challenge` (S256 required), `scope`, `state`; then redirects the browser to the web app at `/oauth/consent?request=<id>` where the signed-in user approves.
- `GET /api/oauth/requests/:id` (session) → `OAuthGrantInfo`; `POST /api/oauth/requests/:id/approve` `{ access: 'read' | 'write', workspaceId? }` → `{ redirect }`; `POST …/deny` → `{ redirect }` (with `error=access_denied`). Requests expire after 10 minutes.
- `POST /oauth/token`: `authorization_code` (+ `code_verifier`, one-time code, 60 s life) and `refresh_token` (rotating). Access tokens last 1 hour, refresh tokens 60 days; store only hashes. Access tokens work as bearer credentials on `/mcp` and `/api`.
- `/mcp` 401 responses carry `WWW-Authenticate: Bearer resource_metadata="<public url>/.well-known/oauth-protected-resource"`.
- `GET /api/connected-apps` → `ConnectedApp[]` (the user's grants); `DELETE /api/connected-apps/:id` revokes.
- `CAIRN_PUBLIC_URL` is used for every absolute URL; fall back to the request origin (honour `X-Forwarded-Proto` / `X-Forwarded-Host`).

## 10. Hardening and housekeeping

- Security headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` (except public share pages may be framed: omit there), and a Content-Security-Policy for the HTML shell that allows self scripts/styles, inline styles, `img-src 'self' data: blob: https:`, `connect-src 'self'`.
- Static assets under `/assets/` get `Cache-Control: public, max-age=31536000, immutable`; `index.html`, `sw.js` and `manifest.webmanifest` get `no-cache`.
- Request body limit 2 MB for JSON; uploads/imports 200 MB for `.zip` import, 20 MB otherwise.
- Purge expired sessions, invites, OAuth codes and trashed pages older than 30 days once a day.
- Tests for everything above (ICS parsing incl. recurrence, export → import round trip, CSV inference, home/stickies permissions, bearer auth incl. read-only tokens, backup create + local retention + restore via the CLI functions, OAuth happy path and PKCE failure, new MCP tools). Mock outbound HTTP (Notion, WebDAV, ICS) with an injected `fetch`.

Done when `npm test` and `npx tsc -p server/tsconfig.json --noEmit` pass. Do not touch `web/`.
