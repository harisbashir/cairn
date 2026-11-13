// A small toolbar above the table the cursor is in: add or remove rows and columns, delete the table.
import type { Editor as TEditor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { BubbleMenu } from '@tiptap/react/menus';
import { BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, Columns2, Rows2, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';

function tableElement(editor: TEditor): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name !== 'table') continue;
    const dom = editor.view.nodeDOM($from.before(d)) as HTMLElement | null;
    return dom?.closest?.('.tableWrapper') as HTMLElement ?? dom;
  }
  return null;
}

export function TableMenu({ editor }: { editor: TEditor }) {
  const btn = (label: string, icon: ReactNode, run: () => void, danger = false) => (
    <button type="button" aria-label={label} title={label} className={danger ? 'danger' : ''} onMouseDown={(e) => { e.preventDefault(); run(); }}>{icon}</button>
  );
  const c = () => editor.chain().focus();
  return (
    <BubbleMenu
      editor={editor} pluginKey="tableMenu" className="table-menu"
      shouldShow={({ editor, state }) => editor.isEditable && editor.isActive('table') && (state.selection.empty || state.selection instanceof CellSelection)}
      getReferencedVirtualElement={() => {
        const el = tableElement(editor);
        if (!el) return null;
        return { getBoundingClientRect: () => el.getBoundingClientRect(), getClientRects: () => el.getClientRects() };
      }}
      options={{ placement: 'top-start', offset: 6, flip: true, shift: { padding: 8 } }}
    >
      <div className="bubble" role="toolbar" aria-label="Table">
        {btn('Add row above', <BetweenHorizontalStart size={16} />, () => c().addRowBefore().run())}
        {btn('Add row below', <BetweenHorizontalEnd size={16} />, () => c().addRowAfter().run())}
        {btn('Delete row', <span className="tm-del"><Rows2 size={16} /><X size={10} strokeWidth={3} /></span>, () => c().deleteRow().run())}
        <span className="bubble-sep" aria-hidden />
        {btn('Add column left', <BetweenVerticalStart size={16} />, () => c().addColumnBefore().run())}
        {btn('Add column right', <BetweenVerticalEnd size={16} />, () => c().addColumnAfter().run())}
        {btn('Delete column', <span className="tm-del"><Columns2 size={16} /><X size={10} strokeWidth={3} /></span>, () => c().deleteColumn().run())}
        <span className="bubble-sep" aria-hidden />
        {btn('Delete table', <Trash2 size={16} />, () => c().deleteTable().run(), true)}
      </div>
    </BubbleMenu>
  );
}
