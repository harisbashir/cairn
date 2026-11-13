// v0.3 editor blocks: toggles, tables, columns, mentions and linked database views.
// Node names and attrs are the contract in docs/SPEC-0.3.md section 1 (shared/markdown.ts depends on them).
import { Extension, mergeAttributes, Node, type Editor as TEditor, type Range } from '@tiptap/core';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TextSelection } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Columns2, Columns3, Database, ListCollapse, Table2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { LinkedView } from './LinkedView.tsx';
import { dateLabel, personColor } from './Mentions.tsx';
import './editor.css';

export interface MenuItemDef {
  id: string;
  title: string;
  desc?: string;
  icon: ReactNode;
  section?: string;
  run: (editor: TEditor, range: Range) => void;
}

// ---------- Columns ----------
export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,4}',
  defining: true,
  isolating: true,
  parseHTML() { return [{ tag: 'div[data-type="columns"]' }]; },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns', class: 'columns', 'data-count': node.childCount }), 0];
  },
  addKeyboardShortcuts() {
    return {
      // Backspace at the very start of an empty set of columns removes it, like an empty paragraph.
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const $from = selection.$from;
        if ($from.parentOffset !== 0) return false;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name !== 'columns') continue;
          const cols = $from.node(d);
          const empty = cols.textContent === '' && !findAtom(cols);
          if (!empty) return false;
          const pos = $from.before(d);
          return editor.chain().command(({ tr }) => {
            tr.replaceWith(pos, pos + cols.nodeSize, editor.schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, pos + 1));
            return true;
          }).run();
        }
        return false;
      },
    };
  },
});

function findAtom(node: import('@tiptap/pm/model').Node): boolean {
  let found = false;
  node.descendants((n) => { if (n.isAtom && !n.isText) found = true; return !found; });
  return found;
}

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  addAttributes() {
    return {
      width: {
        default: null,
        parseHTML: (el) => { const v = parseFloat(el.getAttribute('data-width') ?? ''); return Number.isFinite(v) ? v : null; },
        renderHTML: (a) => (a.width ? { 'data-width': a.width, style: `flex-grow: ${a.width}` } : {}),
      },
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="column"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'column' }), 0]; },
});

// ---------- Mentions (people and dates; pages stay pageLink nodes) ----------
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: 'user', parseHTML: (el) => el.getAttribute('data-kind') ?? 'user', renderHTML: (a) => ({ 'data-kind': a.kind }) },
      id: { default: '', parseHTML: (el) => el.getAttribute('data-id') ?? '', renderHTML: (a) => ({ 'data-id': a.id }) },
      label: { default: '', parseHTML: (el) => el.getAttribute('data-label') ?? el.textContent ?? '', renderHTML: (a) => ({ 'data-label': a.label }) },
    };
  },
  parseHTML() { return [{ tag: 'span[data-mention]' }]; },
  renderHTML({ HTMLAttributes, node }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-mention': '', class: `mention ${node.attrs.kind}` }), mentionText(node.attrs)];
  },
  renderText({ node }) { return mentionText(node.attrs); },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      dom.className = `mention ${node.attrs.kind}`;
      dom.setAttribute('data-mention', '');
      dom.setAttribute('data-kind', node.attrs.kind);
      dom.setAttribute('data-id', node.attrs.id);
      dom.contentEditable = 'false';
      const paint = () => {
        dom.textContent = '';
        if (node.attrs.kind === 'user') {
          const dot = document.createElement('span');
          dot.className = 'mention-dot';
          dot.style.background = personColor(node.attrs.id) ?? 'var(--text-3)';
          dom.append(dot, document.createTextNode(node.attrs.label || 'Someone'));
          dom.title = node.attrs.label;
        } else {
          dom.append(document.createTextNode(dateLabel(node.attrs.id)));
          dom.title = node.attrs.label || node.attrs.id;
        }
      };
      paint();
      const repaint = () => paint();
      window.addEventListener('cairn:people', repaint);
      return { dom, destroy: () => window.removeEventListener('cairn:people', repaint) };
    };
  },
});

function mentionText(a: Record<string, unknown>) {
  return a.kind === 'date' ? String(a.label || a.id) : `@${String(a.label || 'Someone')}`;
}

// ---------- Linked database view ----------
export const DatabaseViewBlock = Node.create({
  name: 'databaseView',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    const json = (name: string, fallback: unknown) => ({
      default: fallback,
      parseHTML: (el: HTMLElement) => { try { return JSON.parse(el.getAttribute(`data-${name}`) ?? ''); } catch { return fallback; } },
      renderHTML: (a: Record<string, unknown>) => ({ [`data-${name}`]: JSON.stringify(a[name]) }),
    });
    return {
      databaseId: json('databaseId', ''),
      viewId: json('viewId', null),
      filters: json('filters', []),
      title: json('title', ''),
      limit: json('limit', 10),
    };
  },
  parseHTML() { return [{ tag: 'div[data-type="database-view"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'database-view' })]; },
  addNodeView() {
    // Everything inside the block (cells, buttons, menus) belongs to the database view, not to the editor.
    return ReactNodeViewRenderer(LinkedView, { stopEvent: () => true });
  },
});

// ---------- Toggle keys ----------
/** Enter in a new toggle's summary moves into its (empty) body instead of adding a second empty line. */
const ToggleKeys = Extension.create({
  name: 'toggleKeys',
  priority: 200,
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { $head, empty } = editor.state.selection;
        if (!empty || $head.parent.type.name !== 'detailsSummary' || $head.parentOffset !== $head.parent.content.size) return false;
        const details = $head.node(-1);
        if (details.type.name !== 'details' || !details.attrs.open) return false;
        const body = details.child(1);
        if (body.childCount !== 1 || body.firstChild!.content.size !== 0 || !body.firstChild!.isTextblock) return false;
        const at = $head.after() + 2; // into detailsContent, into its paragraph
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)).scrollIntoView());
        return true;
      },
    };
  },
});

// ---------- Floating-ui markers ----------
/**
 * A popover opened inside a block (a cell editor in a linked view) makes floating-ui tag every
 * sibling element with data-floating-ui-inert / aria-hidden. ProseMirror reads those attribute
 * changes as edits and redraws the blocks, which remounts the node view and closes the popover.
 * Tell ProseMirror's DOM observer to ignore them. (domObserver is internal, so guard it.)
 */
const FLOAT_ATTRS = new Set(['data-floating-ui-inert', 'aria-hidden', 'inert']);
const IgnoreFloatingMarkers = Extension.create({
  name: 'ignoreFloatingMarkers',
  onCreate() {
    const obs = (this.editor.view as unknown as { domObserver?: { registerMutation?: (m: MutationRecord, added: Node[]) => unknown } }).domObserver;
    const orig = obs?.registerMutation;
    if (!obs || typeof orig !== 'function') return;
    obs.registerMutation = function (m: MutationRecord, added: Node[]) {
      if (m.type === 'attributes' && m.attributeName && FLOAT_ATTRS.has(m.attributeName)) return null;
      return orig.call(this, m, added);
    };
  },
});

/** Where the cursor is, for hiding blocks that can't nest there (no tables in tables, no columns in columns). */
export function blockContext(editor: TEditor | null): { inTable: boolean; inColumn: boolean } {
  const out = { inTable: false, inColumn: false };
  if (!editor) return out;
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d).type.name;
    if (n === 'table') out.inTable = true;
    if (n === 'column') out.inColumn = true;
  }
  return out;
}

// ---------- Extension list ----------
/** The block extensions the page editor adds on top of StarterKit. */
export function editorBlocks() {
  return [
    Details.configure({ persist: true, HTMLAttributes: { class: 'toggle' } }),
    DetailsSummary, DetailsContent,
    Table.configure({ resizable: false, renderWrapper: true, HTMLAttributes: { class: 'cairn-table' } }),
    TableRow, TableHeader, TableCell,
    Columns, Column, Mention, DatabaseViewBlock, ToggleKeys, IgnoreFloatingMarkers,
  ];
}

/** Read-only renderers for the same nodes (public pages), without the interactive linked view. */
export function readOnlyBlocks() {
  return [
    Details.configure({ persist: true, HTMLAttributes: { class: 'toggle' } }), DetailsSummary, DetailsContent,
    Table.configure({ resizable: false, renderWrapper: true, HTMLAttributes: { class: 'cairn-table' } }), TableRow, TableHeader, TableCell,
    Columns, Column, Mention,
    DatabaseViewBlock.extend({
      addNodeView: null,
      renderHTML({ node }) {
        return ['div', { 'data-type': 'database-view', class: 'lv-static' }, `Linked view${node.attrs.title ? `: ${node.attrs.title}` : ' of a database'}`];
      },
    }),
  ];
}

// ---------- Slash menu ----------
export function blockSlashItems(editor: TEditor | null = null): MenuItemDef[] {
  const item = (id: string, title: string, desc: string, icon: ReactNode, content: (e: TEditor) => object | null): MenuItemDef => ({
    id, title, desc, icon,
    run: (editor, range) => {
      const c = content(editor);
      editor.chain().focus().deleteRange(range).run();
      if (c) {
        // Replace the now-empty line rather than leaving a blank paragraph above the new block.
        // Otherwise insert below the current line. Then put the cursor in the new block's first line.
        const { $from } = editor.state.selection;
        const blank = $from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth > 0;
        const at = $from.depth === 0 ? $from.pos : blank ? $from.before() : $from.after();
        if (blank) editor.chain().insertContentAt({ from: at, to: $from.after() }, c).run();
        else editor.chain().insertContentAt(at, c).run();
        const sel = TextSelection.findFrom(editor.state.doc.resolve(at), 1, true);
        if (sel) editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView());
      }
    },
  });
  const columns = (n: number) => ({ type: 'columns', content: Array.from({ length: n }, () => ({ type: 'column', content: [{ type: 'paragraph' }] })) });
  const ctx = blockContext(editor);
  const all: MenuItemDef[] = [
    item('toggle', 'Toggle', 'Hide details under a heading', <ListCollapse size={17} />,
      () => ({ type: 'details', attrs: { open: true }, content: [{ type: 'detailsSummary' }, { type: 'detailsContent', content: [{ type: 'paragraph' }] }] })),
    { id: 'table', title: 'Table', desc: 'A simple grid with a header row', icon: <Table2 size={17} />,
      run: (editor, range) => { editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
    item('columns2', '2 columns', 'Place blocks side by side', <Columns2 size={17} />, () => columns(2)),
    item('columns3', '3 columns', 'Place blocks side by side', <Columns3 size={17} />, () => columns(3)),
    item('linked', 'Linked view of a database', 'Show rows from a database here', <Database size={17} />,
      () => ({ type: 'databaseView', attrs: { databaseId: '', viewId: null, filters: [], title: '', limit: 10 } })),
  ];
  // Cells hold text only; columns don't nest.
  if (ctx.inTable) return all.filter((i) => i.id !== 'table' && i.id !== 'linked' && !i.id.startsWith('columns'));
  if (ctx.inColumn) return all.filter((i) => !i.id.startsWith('columns'));
  return all;
}
