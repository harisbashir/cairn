import {
  Activity, CalendarDays, ChartColumn, FileText, History, Link2, NotebookPen, Star, StickyNote, Sun, Table2, type LucideIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { TreeNode, Widget, WidgetType } from '../../../shared/types.ts';
import { AddNoteButton, StickiesWidget } from './Stickies.tsx';
import { str, type WidgetProps } from './types.ts';
import { ActivityWidget } from './widgets/Activity.tsx';
import { CalendarWidget } from './widgets/Calendar.tsx';
import { FavoritesWidget } from './widgets/Favorites.tsx';
import { LinksWidget } from './widgets/Links.tsx';
import { NoteWidget } from './widgets/Note.tsx';
import { PageWidget } from './widgets/PageEmbed.tsx';
import { RecentWidget } from './widgets/Recent.tsx';
import { StatsWidget } from './widgets/Stats.tsx';
import { ViewWidget } from './widgets/View.tsx';
import { WelcomeWidget } from './widgets/Welcome.tsx';

export interface WidgetKind {
  type: WidgetType;
  name: string; // default heading and gallery name
  description: string;
  icon: LucideIcon;
  size: Widget['size'];
  config: Record<string, unknown>;
  Component: ComponentType<WidgetProps>;
  /** Small action shown at the right of the heading outside Customize mode. */
  Action?: ComponentType;
  /** Page the heading links to, if any. */
  target?: (w: Widget) => string;
}

export const WIDGETS: WidgetKind[] = [
  { type: 'welcome', name: 'Welcome', description: 'A greeting with quick actions to create, search and connect AI.', icon: Sun, size: 'full', config: {}, Component: WelcomeWidget },
  { type: 'recent', name: 'Jump back in', description: 'Pages you edited most recently.', icon: History, size: 'full', config: {}, Component: RecentWidget },
  { type: 'favorites', name: 'Favorites', description: 'Your starred pages, one click away.', icon: Star, size: 'third', config: {}, Component: FavoritesWidget },
  { type: 'activity', name: 'Latest activity', description: 'What you, your team and AI agents changed lately.', icon: Activity, size: 'half', config: { limit: 10 }, Component: ActivityWidget },
  { type: 'stickies', name: 'Sticky notes', description: 'A wall of quick notes for yourself or the whole team.', icon: StickyNote, size: 'half', config: {}, Component: StickiesWidget, Action: AddNoteButton },
  { type: 'view', name: 'Database view', description: 'Any view of a database, such as a board or a table.', icon: Table2, size: 'full', config: { limit: 10 }, Component: ViewWidget, target: (w) => str(w.config.databaseId) },
  { type: 'page', name: 'Page', description: 'The content of a page, shown read-only.', icon: FileText, size: 'half', config: {}, Component: PageWidget, target: (w) => str(w.config.pageId) },
  { type: 'note', name: 'Note', description: 'Free text written right on the dashboard.', icon: NotebookPen, size: 'third', config: { markdown: '' }, Component: NoteWidget },
  { type: 'links', name: 'Quick links', description: 'Buttons to websites and pages you open often.', icon: Link2, size: 'third', config: { links: [] }, Component: LinksWidget },
  { type: 'calendar', name: 'Coming up', description: 'Dated rows and subscribed calendars for the days ahead.', icon: CalendarDays, size: 'third', config: { days: 14 }, Component: CalendarWidget },
  { type: 'stats', name: 'Workspace at a glance', description: 'Counts of pages, rows, members and edits this week.', icon: ChartColumn, size: 'two-thirds', config: {}, Component: StatsWidget },
];

export const KIND = new Map(WIDGETS.map((k) => [k.type, k]));

/** Shown when the server has no layout to offer (or can't be reached). */
export const DEFAULT_WIDGETS: Widget[] = [
  { id: 'welcome', type: 'welcome', size: 'full', config: {} },
  { id: 'recent', type: 'recent', size: 'full', config: {} },
  { id: 'stickies', type: 'stickies', size: 'half', config: {} },
  { id: 'activity', type: 'activity', size: 'half', config: {} },
];

/** Heading text: the custom title, else the linked page's title, else the widget's name. */
export function headingOf(w: Widget, nodes: TreeNode[]): string {
  if (w.title?.trim()) return w.title.trim();
  const kind = KIND.get(w.type);
  const id = kind?.target?.(w);
  const node = id ? nodes.find((n) => n.id === id) : undefined;
  return node ? node.title || 'Untitled' : kind?.name ?? 'Widget';
}
