# Cairn v0.3 backend additions

Everything in `docs/SPEC.md` and `docs/SPEC-0.2.md` still holds. This document adds to it.
`shared/types.ts` has already been extended and is the contract: return exactly those shapes.
Existing stored data must keep working: add a migration (`PRAGMA user_version` 3) and default every
new field when it is missing (`Page.repeat` null, `reminders` [], `isTemplate` false,
`defaultTemplateId` null, `Activity.clientName` null, the new `UserPrefs` fields).

## 1. Editor document nodes (contract for web, Markdown and MCP)

New ProseMirror node types the web editor will produce. The server stores them as-is; extend
`shared/markdown.ts` (both directions where stated) and `docToPlainText` (include their text):

| Node | Attrs / content | Markdown |
| --- | --- | --- |
| `details` (toggle) | `open: boolean`; content `detailsSummary detailsContent` | `<details><summary>Summary</summary>` … body … `</details>` both ways |
| `detailsSummary` | inline content | |
| `detailsContent` | `block+` | |
| `table` | content `tableRow+` | GFM table both ways (first row = header). Cells hold paragraphs; multi-paragraph cells joined with `<br>` |
| `tableRow` | content `(tableCell \| tableHeader)+` | |
| `tableCell`, `tableHeader` | `colspan`, `rowspan`, `colwidth`; content `block+` | |
| `columns` | content `column{2,4}` | blocks of each column one after another (one way: no columns from Markdown) |
| `column` | `width` (fraction, optional); content `block+` | |
| `mention` (inline atom) | `kind: 'user' \| 'date'`, `id` (user id or `YYYY-MM-DD`), `label` | `@[label](cairn://user/<id>)` / `@[label](cairn://date/<YYYY-MM-DD>)` both ways |
| `databaseView` (block atom) | `databaseId`, `viewId` (or null = first view), `filters: Filter[]` (extra, `@this` allowed), `title` (or '' = database title), `limit` (rows shown before "Show all", default 10) | `[Linked view: <title>](cairn://page/<databaseId>?view=<viewId>)` one way |

Page links inside text stay `pageLink` nodes (existing) and count as mentions of a page.

## 2. Property types: files, rollup, formula

- `files`: value is an array of `/files/<id>/<name>` URLs of files uploaded to the same workspace
  (validate on write: each must be an existing, non-deleted file of that workspace). Exports list
  file names; CSV joins with `;`. Import does not create files values.
- `rollup` and `formula` are computed on every read where rows are returned (`GET /api/pages/:id/rows`,
  `GET /api/pages/:id` for rows, MCP `query_database` / `get_page`, exports, calendar never). Writes
  to them are rejected with 400. Values: numbers, `'YYYY-MM-DD'`/ISO strings, booleans, `string[]`
  for `show`, or null.
- Compute in `shared/compute.ts` (pure, no server imports) so the web can reuse it:
  `computeRows(rows, schema, ctx)` where `ctx` gives access to other databases' rows and schemas.
  Rollups run before formulas; formulas may reference rollups and other formulas (detect cycles →
  null). Template rows are never included.
- Rollup `source.kind 'incoming'`: related rows are rows of `databaseId` whose relation property
  `propertyId` contains this row's id. The caller only sees rows they can see.
- `applyView` (shared/query.ts) must filter and sort on computed values (they are in `props`), and
  treat computed numbers as numbers and computed dates as dates. Resolve `@this`, `@me`, `@today`
  filter values: `applyView(rows, view, schema, { thisPageId?, userId?, today? })` (keep the old
  signature working).
- Schema validation: rollup source property must exist and be a relation (or, incoming, a relation
  in a database of the same workspace pointing at this database); target must exist; `fn` must fit
  the target type (sum/avg/min/max on number, earliest/latest on date, percent_checked on checkbox).
  Formula expression must parse; store the inferred `resultType`.

## 3. Formula language (`shared/formula.ts`)

Small, safe, no `eval`. Parse once per schema version, evaluate per row.

- Literals: numbers, `"text"` / `'text'`, `true`, `false`.
- `prop("Name")` → the property value by name (title as `prop("Name")` where Name is the title, or
  `prop("title")`). Options become their names, people their names, relations the related titles
  (comma-joined text), dates `'YYYY-MM-DD'`/ISO strings treated as dates, checkboxes booleans.
- Operators: `+ - * / %`, unary `-`, `== != > < >= <=`, `and or not`, parentheses. `+` on text
  concatenates.
- Functions: `if(c, a, b)`, `empty(x)`, `length(x)`, `concat(a, …)`, `lower`, `upper`,
  `contains(text, part)`, `round(n, digits?)`, `floor`, `ceil`, `abs`, `min(…)`, `max(…)`,
  `now()`, `today()`, `dateAdd(date, n, unit)`, `dateSubtract(date, n, unit)`,
  `dateBetween(a, b, unit)` (a − b, whole units), `formatDate(date, style?)` (`'short'` default:
  "12 Nov 2026"; `'iso'`), `year(d)`, `month(d)`, `day(d)`, `weekday(d)` (0 = Sunday),
  `toNumber(x)`, `format(x)`. Units: `'days' 'weeks' 'months' 'years' 'hours' 'minutes'`.
- Errors (unknown property, bad types, division by zero) make that row's value null, never throw.
  `parseFormula` returns `{ ok: false, message, at }` for syntax errors so the UI can show them.
- Depth / length limits: expression ≤ 2000 characters, ≤ 200 nodes.

## 4. Repeating rows

- `PATCH /api/pages/:id` accepts `repeat: Repeat | null` on rows (validate: dateProp is a date
  property, doneProp exists and is status/select/checkbox, doneValue/resetValue are valid option ids
  or booleans, every 1..365, weekdays only with unit week).
- When a patch (REST or MCP) changes `doneProp` to `doneValue` on a row with `repeat`, in the same
  write: compute the next date (from the old date value, or from today in the actor's timezone when
  `from: 'completed'`; month arithmetic clamps to the month's last day; keep the time part for ISO
  values; skip forward until strictly after today when `from: 'due'`), set `dateProp` to it and
  `doneProp` to `resetValue`. If the next date is after `until`, leave the row done and clear
  `repeat`. Record activity action `repeated`. Reset every reminder's `lastFiredFor`.
- `PATCH /api/pages/:id` accepts `reminders: Reminder[]` (server fills `id`, `createdBy`,
  `lastFiredFor` for new entries; max 10 per page). Pages (non-rows) may only use absolute reminders.

## 5. Reminders, notifications, push and email

- Scheduler (once a minute, in the existing jobs/housekeeping style): for each non-trashed,
  non-template page with reminders, compute the occurrence (the date value, or `at`) and fire time
  per recipient (date-only values: `reminderHour` in the recipient's `timezone`, minus
  `offsetMinutes`). Fire when due and `lastFiredFor` differs from the occurrence; don't fire
  occurrences more than 24 hours late (just mark them). Recipients must still be able to see the page.
- A fired reminder, a mention, a comment and an assignment each create a `Notification` for the
  recipient (never for the actor themself), emit `{ type: 'notifications' }` to that user only, and
  deliver per the recipient's `prefs.notify`:
  - mention: a `mention` node with kind user added to page content or a comment (diff old vs new
    content: only newly added mentions notify);
  - assigned: a user newly added to a `person` property of a row;
  - comment: a new comment on a page the recipient created, or a reply in a thread they posted in,
    or a mention in a comment (one notification per recipient per comment).
- Endpoints:

| Method and path | Body | Returns |
| --- | --- | --- |
| GET `/api/notifications?unread=1&limit=50&before=` | | `Notification[]` newest first (all workspaces) |
| POST `/api/notifications/read` | `{ ids?: string[] }` (omitted = all) | `{ ok: true }` |
| GET `/api/notifications/count` | | `{ unread: number }` |
| GET `/api/push/key` | | `{ publicKey: string }` (VAPID, generated once and stored) |
| GET `/api/push/subscriptions` | | `PushSubscriptionInfo[]` (the caller's) |
| POST `/api/push/subscriptions` | `{ subscription: PushSubscriptionJSON, device?: string }` | `PushSubscriptionInfo` (upsert by endpoint) |
| DELETE `/api/push/subscriptions/:id` | | `{ ok: true }` |
| POST `/api/push/test` | | `{ ok, message }` sends a test push to all the caller's devices |
| GET/PUT `/api/admin/mail` | `MailSettings` | `MailSettings` (admin; password write-only) |
| POST `/api/admin/mail/test` | `{ to? }` | `{ ok, message }` |
| GET `/api/workspaces/:wid/reminders?days=14` | | `{ pageId, title, icon, fireAt, occurrence }[]` the caller's upcoming reminders |

- Web Push: use the `web-push` npm package (add it). Payload JSON
  `{ title, body, url: '/p/<pageId>', tag: notification id }`. Subscriptions are stored per user;
  delete a subscription when the push service answers 404/410. `VAPID` subject = `CAIRN_PUBLIC_URL`
  or `mailto:` the first admin's email.
- Email: use `nodemailer` (add it). Plain text plus a simple HTML version with a link to the page
  (absolute URL via `CAIRN_PUBLIC_URL`). Send only when mail is enabled and the recipient has
  `notify.email`. Failures are logged, never thrown into the request.
- Keep notifications 90 days. User deletion removes their notifications and subscriptions.

## 6. Templates

- `isTemplate` rows stay children of their database but are excluded from `GET /api/pages/:id/rows`,
  rollups, the calendar, the ICS feed, CSV export, search, `query_database` and stats.
  `isTemplate` pages (kind page) are excluded from the tree, search, recent and the home widgets;
  they have `parentId: null`.
- `GET /api/workspaces/:wid/templates` → `TemplateSummary[]` (page templates, and row templates of
  every database the caller can see). `GET /api/pages/:id/templates` → `TemplateSummary[]` of one
  database.
- `POST /api/workspaces/:wid/pages` (create) accepts `templateId`: copies icon, cover, content
  (and for rows, props; for pages, child pages recursively) from the template. `title` from the
  request wins, else the template's title. Text `{{date}}` in the title or content becomes today's
  date (`YYYY-MM-DD` in the actor's timezone); a date property whose template value is the string
  `'@today'` becomes today. With no `templateId`, a new row in a database with `defaultTemplateId`
  uses that template unless the request says `templateId: null` explicitly.
- `POST /api/pages/:id/save-as-template` `{ title? }` → `Page` (a copy flagged `isTemplate`; a row
  copy stays in its database; a page copy goes to the root, child pages copied too).
- A template is edited like any page (`GET/PATCH /api/pages/:id`). `PATCH` on a database accepts
  `defaultTemplateId` (must be a template row of that database, or null).
- Trashing a database's default template clears `defaultTemplateId`.

## 7. Backlinks

- Maintain a `links` table (`fromId`, `toId`, `via`), rebuilt for a page on every content or
  relation change and once in the migration. A page links to another through a `pageLink` node, a
  `link` mark whose href is `/p/<id>` (relative or absolute to this server), or a `databaseView`
  block does NOT count.
- `GET /api/pages/:id/backlinks` → `Backlink[]`: linking pages the caller can see, not trashed, not
  templates, newest first; `via 'relation'` for rows whose relation properties point at this page;
  `snippet` = ~120 characters of plain text around the first link (or the row's database title for
  relations).
- `GET /api/workspaces/:wid/mentionables?q=` → `{ pages: { id, title, icon, path }[], people: { id, name, color }[] }`
  (max 8 each) for the @-menu.

## 8. Comments

| Method and path | Body | Returns |
| --- | --- | --- |
| GET `/api/pages/:id/comments` | | `Comment[]` oldest first |
| POST `/api/pages/:id/comments` | `{ body, quote?, threadId? }` | `Comment` (viewers can comment; body 1..5000 chars) |
| PATCH `/api/comments/:id` | `{ body?, resolved? }` | `Comment` (body: author only; resolved: any editor, applies to the thread) |
| DELETE `/api/comments/:id` | | `{ ok: true }` (author or workspace owner/admin; deleting the first comment deletes the thread) |

`GET /api/pages/:id` gains `commentCount` (open threads). Emit `{ type: 'comments', pageId }` to the
workspace. Comments are included in the JSON export and the workspace zip (`cairn.json`).

## 9. Change review and undo

- Every page change records, on its activity entry, the fields it touched with their before and after
  values (title, icon, cover, content, props by key, schema, views, parentId+position, visibility,
  deletedAt, repeat, reminders, isTemplate). Store them in a separate `changes` table keyed by the
  activity id (so the activity list stays light). Keep 90 days. Merge rapid edits: consecutive
  updates by the same actor and client on the same page within 2 minutes extend the previous
  change (keep its original `before`, update `after` and `at`).
- `Activity.clientName`: the API token's name, or the OAuth client's `clientName`, for
  bearer/MCP requests; null for the web app.
- Endpoints:

| Method and path | Body | Returns |
| --- | --- | --- |
| GET `/api/workspaces/:wid/changes?actor=ai\|user\|all&client=&before=&limit=50` | | `ChangeSummary[]` newest first, only pages the caller can see; default `actor=ai` |
| GET `/api/changes/:id` | | `ChangeDetail` |
| POST `/api/changes/:id/undo` | `{ force?: boolean }` | `ChangeSummary`. Restores the before values of exactly the touched fields. `created` → move to trash; `deleted` → restore; `moved` → move back. 409 `conflict` when the page changed since and `force` isn't set. Needs edit rights. Records the undo as action `undone` by the caller and marks the change undone. |
| POST `/api/changes/undo` | `{ ids: string[], force?: boolean }` | `{ undone: string[], conflicts: string[], failed: string[] }` applied newest first |

- `diffs` in `ChangeDetail`: content as Markdown (`docToMarkdown`), properties as display values
  (option names, user names, related titles, dates), schema/views summarised as lists of names.

## 10. Quick capture

- `POST /api/capture` `{ title?, text?, url?, workspaceId?, databaseId? }` → `{ page: Page }`.
  Target: the body's workspace/database, else `prefs.capture`, else 400 `no_target`. Into a
  database: a new row (default template applies) with `title` (or the URL's hostname + path, or
  the first line of text), the first `url` property set to `url`, and the body
  `text`/`url` as paragraphs (URL as a link). Into a workspace: a page at the root with the same
  body. Works with bearer tokens, so iOS Shortcuts can post to it.

## 11. MCP additions

Keep every tool. Changes:

- `create_row` and `create_page` accept `template` (template title or id). `update_row` accepts
  `repeat` (`{ date_property, every, unit, weekdays?, from?, until?, done_property, done_value,
  reset_value }`, names not ids; `null` clears) and `reminders` (`{ date_property?, minutes_before?,
  at?, people? }[]`, people by name or email; `null` clears).
- `add_property` / `update_database` accept `files`, `rollup` (`{ relation, incoming_database?,
  target, function, filters? }` by names) and `formula` (`{ expression }`) properties. Read results
  include computed values by property name.
- New: `list_templates(workspace_id, database_id?)`, `save_as_template(page_id, title?)`,
  `get_backlinks(page_id)`, `list_comments(page_id)`, `add_comment(page_id, body, quote?, thread_id?)`,
  `list_changes(workspace_id, actor?, client?, limit?)`, `capture(title?, text?, url?, workspace_id?,
  database_id?)`. Annotate them like the others. Read-only tokens don't see mutating tools.
- Markdown in and out supports the section 1 nodes.

## 12. Tests

Cover: formula parser and evaluator (operators, functions, dates, errors, cycles), rollups incl.
incoming relations and filters, `@this`/`@me`/`@today` filters, files validation, repeat (each
unit, weekdays, month-end clamp, `from` modes, until), reminder scheduling with timezones (inject the
clock), notifications for mention/assigned/comment (no self-notify, only new mentions), push
delivery with an injected sender (410 removes the subscription), mail with an injected transport,
templates (row and page, default template, `{{date}}`, `@today`, exclusions), backlinks
(link/mention/relation, visibility), comments permissions, change recording + merge window + undo
(each action, conflict, force, batch), `clientName`, capture, the new MCP tools, Markdown round trips
for the new nodes, and the migration on a v0.2 database.

Done when `npm test` and `npx tsc -p server/tsconfig.json --noEmit` pass. Do not touch `web/`.
