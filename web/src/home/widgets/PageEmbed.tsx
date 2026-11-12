import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Page } from '../../../../shared/types.ts';
import { usePage } from '../../api.ts';
import { Callout, PageLink } from '../../Editor.tsx';
import { useShell } from '../../Shell.tsx';
import { str, type WidgetProps } from '../types.ts';
import { SettingSelect, Settings, WidgetMessage } from './kit.tsx';

function ReadOnlyDoc({ page }: { page: Page }) {
  const s = useShell();
  const navigate = useNavigate();
  const editor = useEditor({
    editable: false,
    extensions: [StarterKit, TaskList, TaskItem, Highlight, Image, Callout, PageLink],
    content: page.content ?? undefined,
  });
  const follow = (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('a[data-page-id]');
    if (!link) return;
    e.preventDefault();
    navigate(`/w/${s.wid}/p/${link.dataset.pageId}`);
  };
  return <div className="hm-doc" onClick={follow}><EditorContent editor={editor} /></div>;
}

export function PageWidget({ widget, editing, onChange }: WidgetProps) {
  const s = useShell();
  const pageId = str(widget.config.pageId);
  const page = usePage(pageId || undefined);
  const pages = (s.tree?.nodes ?? []).filter((n) => n.kind === 'page');
  let body;
  if (!pageId) body = <WidgetMessage>{editing ? 'Choose a page to show its content here.' : 'No page chosen yet. Select Customize to pick one.'}</WidgetMessage>;
  else if (page.isError) body = <WidgetMessage>This page isn’t available any more.</WidgetMessage>;
  else if (!page.data) body = null;
  else if (!page.data.content) body = <WidgetMessage>This page is empty.</WidgetMessage>;
  else body = <ReadOnlyDoc key={`${page.data.id}:${page.data.updatedAt}`} page={page.data} />;
  return (
    <>
      {editing && (
        <Settings>
          <SettingSelect
            label="Page" wide value={pageId}
            options={[{ value: '', label: 'Choose a page…' }, ...pages.map((p) => ({ value: p.id, label: `${p.icon ? `${p.icon} ` : ''}${p.title || 'Untitled'}` }))]}
            onChange={(v) => onChange({ ...widget.config, pageId: v })}
          />
        </Settings>
      )}
      {body}
    </>
  );
}
