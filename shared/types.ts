// Cairn shared contract. The server returns exactly these shapes; the web app consumes them.
// All ids are opaque strings. All timestamps are ISO 8601 strings (UTC).

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type PageKind = 'page' | 'database' | 'row';
export type Visibility = 'workspace' | 'private';
export type ActorType = 'user' | 'ai';

export interface User {
  id: string;
  email: string;
  name: string;
  color: string; // avatar colour, hex
  isAdmin: boolean; // instance administrator
  disabled: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  prefs: UserPrefs;
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type Accent = 'blue' | 'violet' | 'green' | 'orange' | 'pink' | 'graphite';
export interface UserPrefs {
  theme: ThemeMode; // default 'system'
  accent: Accent; // default 'blue'
  timezone: string; // IANA zone, default 'UTC'; the web app sets it from the browser on first load
  reminderHour: number; // 0-23, when reminders on date-only values fire, default 9
  notify: NotifyPrefs;
  capture: CaptureTarget | null; // where phone quick capture saves, default null (ask)
}

export interface NotifyPrefs {
  push: boolean; // default true (only does anything once a device subscribed)
  email: boolean; // default false; needs SMTP configured by the administrator
  mentions: boolean; // notify when someone @-mentions me, default true
  comments: boolean; // notify on replies and comments on pages I created, default true
  assigned: boolean; // notify when I am added to a person property, default true
}

export interface CaptureTarget {
  workspaceId: string;
  databaseId: string | null; // null = a new page at the workspace root
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  icon: string; // emoji or ''
  color: string; // hex
  role: Role; // the current user's role
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  color: string;
  role: Role;
  joinedAt: string;
}

export interface Invite {
  id: string;
  token: string;
  email: string | null;
  role: Role;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

export interface InstanceInfo {
  name: string;
  allowSignup: boolean;
  needsSetup: boolean; // true when no user exists yet; the first sign-up becomes administrator
  version: string;
}

export interface Bootstrap {
  user: User | null;
  instance: InstanceInfo;
  workspaces: WorkspaceSummary[];
}

// ---------- Content ----------

// Tiptap / ProseMirror JSON document.
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

// ---------- Databases ----------

export type PropertyType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'person'
  | 'relation'
  | 'files' // value: string[] of file URLs ('/files/<id>/<name>') uploaded to the workspace
  | 'rollup' // computed, read-only: see RollupConfig
  | 'formula'; // computed, read-only: see FormulaConfig

export type RollupFn =
  | 'count' // number of related rows (after filters)
  | 'count_values' // number of non-empty target values
  | 'sum' | 'avg' | 'min' | 'max' // number targets
  | 'earliest' | 'latest' // date targets → 'YYYY-MM-DD' or ISO
  | 'percent_checked' // checkbox target → 0-100
  | 'show'; // the target values themselves → string[] (titles, option names, or values as text)

export interface RollupConfig {
  // Which related rows: either a relation property of this database, or an incoming relation
  // (a relation property in another database that points at this database).
  source: { kind: 'relation'; propertyId: string } | { kind: 'incoming'; databaseId: string; propertyId: string };
  target: string; // 'title' or a property id of the related database
  fn: RollupFn;
  filters?: Filter[]; // applied to the related rows first, e.g. Status is not Done → "open tasks"
}

export interface FormulaConfig {
  expression: string; // see docs/SPEC-0.3.md, section 3
  // The result type, inferred on save; tells the UI how to render and filter it.
  resultType?: 'text' | 'number' | 'checkbox' | 'date';
}

export interface SelectOption {
  id: string;
  name: string;
  color: OptionColor;
}

export type OptionColor =
  | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'red';

export interface Property {
  id: string; // stable key used in row props
  name: string;
  type: PropertyType;
  options?: SelectOption[]; // select, multi_select, status
  relationDatabaseId?: string; // relation
  rollup?: RollupConfig; // rollup
  formula?: FormulaConfig; // formula
  numberFormat?: 'plain' | 'comma' | 'percent' | 'currency'; // number, rollup and formula numbers; default plain
}

// Row values by property id:
//   text, url: string
//   number: number
//   select, status: option id (string)
//   multi_select: option id[]
//   date: 'YYYY-MM-DD' or full ISO string
//   checkbox: boolean
//   person: user id[]
//   relation: row page id[]
//   files: file URL[]
//   rollup, formula: computed by the server on every read (Row.props, get_page, exports); never stored or writable
// Missing or null means empty. The row title is Page.title, not a property.
export type PropValue = string | number | boolean | string[] | null;
export type Props = Record<string, PropValue>;

export type FilterOp =
  | 'contains' | 'not_contains' | 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte'
  | 'is_empty' | 'is_not_empty' | 'checked' | 'unchecked';

export interface Filter {
  propertyId: string; // 'title' targets the row title
  op: FilterOp;
  // Special values resolved when the view is shown: '@this' = the page the view is embedded in
  // (for relation contains/eq), '@me' = the current user (person), '@today' = today (date).
  value?: PropValue;
}

export interface Sort {
  propertyId: string; // 'title' | 'createdAt' | 'updatedAt' | property id
  dir: 'asc' | 'desc';
}

export type ViewType = 'table' | 'board' | 'list' | 'gallery' | 'calendar' | 'timeline' | 'chart' | 'feed';

export interface ChartConfig {
  kind: 'bar' | 'donut' | 'line';
  groupBy: string; // property id (select, status, multi_select, checkbox, person, relation, date → by month) or 'createdAt'
  measure: 'count' | 'sum' | 'avg';
  valueProp?: string; // number property id, for sum / avg
}

export interface View {
  id: string;
  name: string;
  type: ViewType;
  filters: Filter[];
  sorts: Sort[];
  groupBy?: string; // board + phone card list: any property id (multi-value properties put a row in several groups; dates group by month)
  hidden?: string[]; // hidden property ids
  widths?: Record<string, number>; // table column widths in px
  cardProps?: string[]; // property ids shown on cards (board, gallery, list, calendar, feed, phone). Unset = sensible default.
  columnOrder?: string[]; // board: group ids left to right (option, user, linked row, 'yes'/'no', 'YYYY-MM' or the value; '' = no value)
  hiddenColumns?: string[]; // board: option ids not shown
  dateProp?: string; // calendar + timeline: start date property id
  endDateProp?: string; // timeline: optional end date property id
  zoom?: 'week' | 'month' | 'quarter'; // timeline
  cover?: 'page' | 'none'; // gallery: show the row's cover image
  chart?: ChartConfig;
  phone?: 'auto' | 'same'; // 'auto' (default) renders a phone-friendly layout on small screens
}

// ---------- Pages ----------

// Lightweight node used by the sidebar tree. Rows are never in the tree.
export interface TreeNode {
  id: string;
  parentId: string | null;
  kind: 'page' | 'database';
  title: string;
  icon: string;
  position: number;
  visibility: Visibility;
  createdBy: string;
}

export interface Crumb {
  id: string;
  title: string;
  icon: string;
  kind: PageKind;
}

export interface Page {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: PageKind;
  title: string;
  icon: string;
  cover: string; // '' or a CSS gradient key / image URL
  visibility: Visibility;
  content: DocNode | null; // page body (also for rows; null for an untouched page)
  props: Props; // rows only, otherwise {}
  schema: Property[]; // databases only, otherwise []
  views: View[]; // databases only, otherwise []
  position: number;
  createdBy: string;
  updatedBy: string;
  updatedByType: ActorType;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  // Present on GET /api/pages/:id only:
  breadcrumbs?: Crumb[]; // ancestors from the root down, excluding the page itself
  favorite?: boolean;
  shareToken?: string | null;
  canEdit?: boolean;
  commentCount?: number; // v0.3: open comment threads
  // For rows: the parent database's schema, so the row page can render its properties.
  parentSchema?: Property[];
  // v0.3
  repeat: Repeat | null; // rows only
  reminders: Reminder[]; // rows and pages
  isTemplate: boolean; // template rows live in their database but are hidden from views; template pages are hidden from the tree
  defaultTemplateId: string | null; // databases only: template applied to new rows unless another is chosen
}

// ---------- v0.3: repeating rows, reminders, notifications ----------

export interface Repeat {
  dateProp: string; // the date property that moves forward
  every: number; // 1..365
  unit: 'day' | 'week' | 'month' | 'year';
  weekdays?: number[]; // unit 'week' only: 0-6, 0 = Sunday; next matching weekday
  from: 'due' | 'completed'; // next date counted from the old date, or from the day it was completed
  until: string | null; // 'YYYY-MM-DD'; stop repeating after this date
  // Completion: when this property becomes doneValue (status/select option id, or true for a checkbox),
  // the server moves dateProp to the next occurrence and sets the property to resetValue.
  doneProp: string;
  doneValue: string | boolean;
  resetValue: string | boolean | null;
}

export interface Reminder {
  id: string;
  // Relative to a date property of the row (fires offsetMinutes before it; date-only values count
  // from the recipient's reminderHour in their timezone), or an absolute time when dateProp is null.
  dateProp: string | null;
  offsetMinutes: number; // >= 0, ignored for absolute reminders
  at: string | null; // ISO, absolute reminders only
  // Recipients: these users plus everyone in personProp (if set). Empty = the creator.
  userIds: string[];
  personProp: string | null;
  createdBy: string;
  lastFiredFor: string | null; // the occurrence (date value or 'at') it last fired for, so it fires once per occurrence
}

export type NotificationKind = 'reminder' | 'mention' | 'comment' | 'assigned' | 'repeat';
export interface Notification {
  id: string;
  at: string;
  kind: NotificationKind;
  title: string; // e.g. the row title
  body: string; // e.g. "Due today" or the comment text
  pageId: string | null;
  workspaceId: string;
  actorName: string; // who caused it ('' for reminders)
  read: boolean;
}

export interface PushSubscriptionInfo {
  id: string;
  device: string; // user-agent summary, e.g. "Safari on iPhone"
  createdAt: string;
}

export interface MailSettings {
  // instance administrator; password is write-only (reads return '' and hasPassword)
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean; // TLS from the start (465) instead of STARTTLS
  username: string;
  password: string;
  hasPassword: boolean;
  from: string; // "Cairn <cairn@example.com>"
}

// ---------- v0.3: templates ----------

export interface TemplateSummary {
  id: string; // the template page/row id
  kind: 'page' | 'row';
  title: string;
  icon: string;
  databaseId: string | null; // row templates: their database
  databaseTitle: string;
  isDefault: boolean;
  updatedAt: string;
}

// ---------- v0.3: backlinks ----------

export interface Backlink {
  id: string; // the linking page
  kind: PageKind;
  title: string;
  icon: string;
  path: string; // ancestors, "Parent / Child"
  snippet: string; // plain text around the link
  via: 'link' | 'mention' | 'relation'; // relation = a row whose relation property points here
}

// ---------- v0.3: comments ----------

export interface Comment {
  id: string;
  pageId: string;
  threadId: string; // id of the first comment of the thread (itself for the first)
  quote: string; // text the thread is anchored to ('' = page-level)
  body: string; // plain text; mentions as @[Name](cairn://user/<id>)
  resolved: boolean; // thread state, stored on the first comment
  createdBy: string;
  createdByName: string;
  createdByType: ActorType;
  createdAt: string;
  updatedAt: string;
}

// ---------- v0.3: change review (what AI agents changed, with undo) ----------

export interface ChangeSummary {
  id: string; // = the activity id
  at: string;
  actorName: string;
  actorType: ActorType;
  clientName: string | null; // API token name or OAuth client name, e.g. "Claude Code", "Muse"
  action: Activity['action'];
  pageId: string;
  pageTitle: string;
  pageIcon: string;
  pageKind: PageKind;
  databaseTitle: string; // rows: their database
  fields: string[]; // human labels of what changed: 'Title', 'Content', property names, 'Properties', 'Views', 'Location'
  canUndo: boolean; // false when nothing was recorded, it was already undone, or the page is permanently deleted
  undoneAt: string | null;
  undoneByName: string | null;
}

export interface ChangeDetail extends ChangeSummary {
  // Human-readable before/after per changed field. Content is Markdown; properties by display value.
  diffs: { field: string; before: string; after: string }[];
  conflict: boolean; // the page changed again since; undo would overwrite newer edits
}

export interface Row {
  id: string;
  title: string;
  icon: string;
  props: Props;
  position: number;
  hasContent: boolean;
  cover: string; // the row page's cover, else the first image in its body, else ''
  preview: string; // first ~200 characters of the body as plain text
  createdBy: string;
  createdByName: string;
  updatedByType: ActorType;
  createdAt: string;
  updatedAt: string;
  repeat: Repeat | null; // v0.3
  reminders: Reminder[]; // v0.3
}

export interface Tree {
  nodes: TreeNode[];
  favorites: string[]; // page ids, in the user's order
}

export interface SearchHit {
  id: string;
  kind: PageKind;
  title: string;
  icon: string;
  snippet: string; // plain text; matched terms wrapped in <mark></mark>
  path: string; // "Parent / Child" titles of ancestors
  updatedAt: string;
}

export interface RecentPage {
  id: string;
  kind: PageKind;
  title: string;
  icon: string;
  path: string;
  updatedAt: string;
  updatedByName: string;
  updatedByType: ActorType;
}

export interface TrashItem {
  id: string;
  kind: PageKind;
  title: string;
  icon: string;
  deletedAt: string;
  deletedByName: string;
}

export interface PageVersion {
  id: string;
  title: string;
  createdAt: string;
  createdByName: string;
  createdByType: ActorType;
}

export interface Activity {
  id: string;
  at: string;
  actorName: string;
  actorType: ActorType; // 'ai' when the change came through MCP
  action: 'created' | 'updated' | 'deleted' | 'restored' | 'moved' | 'shared' | 'joined' | 'repeated' | 'undone';
  clientName: string | null; // v0.3: token or OAuth client name for AI changes
  pageId: string | null;
  pageTitle: string;
  pageIcon: string;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string; // first characters, for recognition
  access: 'read' | 'write';
  workspaceId: string | null; // null = every workspace the user belongs to
  createdAt: string;
  lastUsedAt: string | null;
}

// ---------- Admin ----------

export interface AdminOverview {
  users: number;
  workspaces: number;
  pages: number;
  databases: number;
  rows: number;
  aiEdits7d: number;
  storageBytes: number;
}

export interface AdminWorkspace {
  id: string;
  name: string;
  icon: string;
  color: string;
  members: number;
  pages: number;
  ownerName: string;
  createdAt: string;
}

export interface AdminSettings {
  instanceName: string;
  allowSignup: boolean;
}

// ---------- Live events (SSE) ----------

export type LiveEvent =
  | { type: 'page'; pageId: string; parentId: string | null; change: 'created' | 'updated' | 'deleted' | 'restored' | 'moved'; actorId: string; actorType: ActorType; clientId: string | null }
  | { type: 'members' }
  | { type: 'home' }
  | { type: 'stickies' }
  | { type: 'notifications' } // sent only to the recipient's streams
  | { type: 'comments'; pageId: string }
  | { type: 'ping' };

export interface ApiError {
  error: { code: string; message: string };
}

// ---------- Home dashboard ----------

export type WidgetType =
  | 'welcome' // greeting + quick actions
  | 'recent' // recently edited pages
  | 'favorites'
  | 'activity' // latest activity feed
  | 'stickies' // sticky-note wall
  | 'view' // a database view embedded: config { databaseId, viewId? , limit? }
  | 'page' // a page's content embedded read-only: config { pageId }
  | 'note' // free text written on the dashboard: config { markdown }
  | 'links' // quick links: config { links: { label, url }[] }
  | 'calendar' // upcoming dated rows + external calendar events: config { days? }
  | 'stats' // workspace counts
  | 'notifications' // v0.3: my unread notifications and upcoming reminders
  | 'changes'; // v0.3: latest AI changes with a link to the review screen

export interface Widget {
  id: string;
  type: WidgetType;
  title?: string; // overrides the default heading
  size: 'third' | 'half' | 'two-thirds' | 'full'; // width on a 6-column grid (2, 3, 4, 6)
  config: Record<string, unknown>;
}

export interface HomeLayout {
  widgets: Widget[];
  personal: boolean; // true when the user has their own layout instead of the workspace default
  canEditShared: boolean; // owners and admins may change the workspace default
}

export type StickyColor = 'yellow' | 'pink' | 'blue' | 'green' | 'purple' | 'orange' | 'gray';
export interface Sticky {
  id: string;
  workspaceId: string;
  text: string; // plain text, newlines allowed
  color: StickyColor;
  visibility: Visibility; // 'private' = only the author
  position: number;
  createdBy: string;
  createdByName: string;
  createdByType: ActorType;
  createdAt: string;
  updatedAt: string;
}

// ---------- Calendars ----------

export interface ExternalCalendar {
  id: string;
  name: string;
  color: OptionColor;
  url: string; // ICS / iCal subscription address (masked to its host for non-admins)
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // 'YYYY-MM-DD' for all-day, else ISO
  end: string | null;
  allDay: boolean;
  source: 'row' | 'external';
  color: OptionColor;
  calendarName: string; // database title or external calendar name
  pageId: string | null; // row page to open, for source 'row'
  location: string;
}

export interface CalendarFeed {
  url: string | null; // private ICS address others (Google, Apple, Outlook) can subscribe to
}

// ---------- Import / export / jobs ----------

export interface Job {
  id: string;
  kind: 'notion-import' | 'notion-export' | 'import' | 'backup';
  status: 'running' | 'done' | 'failed';
  progress: string; // human-readable, e.g. "AI To-do: 40 of 71 rows"
  error: string | null;
  result: { pageIds?: string[]; url?: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface NotionSource {
  id: string;
  kind: 'database' | 'page';
  title: string;
  icon: string;
}

// ---------- Backups (instance admin) ----------

export type BackupDestinationType = 'local' | 'webdav' | 'rclone';
export interface BackupDestination {
  id: string;
  type: BackupDestinationType;
  name: string;
  // local: {} (kept in the data volume under backups/)
  // webdav (Nextcloud, ownCloud, any WebDAV): { url, username, password }
  // rclone (Google Drive, Dropbox, OneDrive, S3, ...): { remote: 'gdrive:Cairn', config: '<rclone.conf text>' }
  // Secrets (password, config) are write-only: reads return '' and hasSecret: true.
  config: Record<string, string>;
  hasSecret: boolean;
}
export interface BackupSettings {
  enabled: boolean;
  frequency: 'hourly' | 'daily' | 'weekly';
  hour: number; // 0-23, server local time, for daily / weekly
  weekday: number; // 0-6 (0 = Sunday), for weekly
  keep: number; // how many backups to keep per destination
  destinations: BackupDestination[];
  rcloneAvailable: boolean; // whether the rclone binary is installed on the server
}
export interface BackupRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed';
  sizeBytes: number;
  trigger: 'schedule' | 'manual';
  results: { destinationId: string; name: string; ok: boolean; message: string }[];
  downloadable: boolean; // a local copy exists
}

// ---------- OAuth (MCP clients and mobile apps) ----------
export interface OAuthGrantInfo {
  clientName: string;
  redirectHost: string;
  scope: 'read' | 'write';
}
export interface ConnectedApp {
  id: string;
  clientName: string;
  access: 'read' | 'write';
  createdAt: string;
  lastUsedAt: string | null;
}
