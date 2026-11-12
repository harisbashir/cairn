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
  | 'relation';

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
// Missing or null means empty. The row title is Page.title, not a property.
export type PropValue = string | number | boolean | string[] | null;
export type Props = Record<string, PropValue>;

export type FilterOp =
  | 'contains' | 'not_contains' | 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte'
  | 'is_empty' | 'is_not_empty' | 'checked' | 'unchecked';

export interface Filter {
  propertyId: string; // 'title' targets the row title
  op: FilterOp;
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
  // For rows: the parent database's schema, so the row page can render its properties.
  parentSchema?: Property[];
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
  action: 'created' | 'updated' | 'deleted' | 'restored' | 'moved' | 'shared' | 'joined';
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
  | 'stats'; // workspace counts

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
