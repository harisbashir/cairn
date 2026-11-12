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

export type ViewType = 'table' | 'board' | 'list';

export interface View {
  id: string;
  name: string;
  type: ViewType;
  filters: Filter[];
  sorts: Sort[];
  groupBy?: string; // board: a select/status property id
  hidden?: string[]; // hidden property ids
  widths?: Record<string, number>; // table column widths in px
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
  | { type: 'ping' };

export interface ApiError {
  error: { code: string; message: string };
}
