import { useQuery } from '@tanstack/react-query';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent, useEditor } from '@tiptap/react';
import { useParams } from 'react-router-dom';
import { applyView } from '../../shared/query.ts';
import type { Page, Row } from '../../shared/types.ts';
import { get } from './api.ts';
import { PropValueView } from './Database.tsx';
import { Callout, PageLink } from './Editor.tsx';

function ReadOnlyDoc({ page, token }: { page: Page; token: string }) {
  const editor = useEditor({
    editable: false,
    extensions: [StarterKit, TaskList, TaskItem, Highlight, Image, Callout, PageLink],
    content: withShare(page.content, token) ?? undefined,
  });
  return <EditorContent editor={editor} />;
}

// Uploaded images need the share token to load without a session.
function withShare<T>(node: T, token: string): T {
  if (!node || typeof node !== 'object') return node;
  const n = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
  const attrs = n.type === 'image' && typeof n.attrs?.src === 'string' && n.attrs.src.startsWith('/files/')
    ? { ...n.attrs, src: `${n.attrs.src}?share=${token}` } : n.attrs;
  return { ...n, attrs, content: n.content?.map((c) => withShare(c, token)) } as T;
}

export function PublicPage() {
  const { token = '' } = useParams();
  const q = useQuery({ queryKey: ['public', token], queryFn: () => get<{ page: Page; rows: Row[] }>(`/api/public/${token}`), retry: false });
  if (q.isPending) return null;
  if (q.isError) {
    return <div className="auth"><div className="auth-card"><img src="/logo.svg" alt="" /><h1>This page isn’t shared</h1><p className="muted">The link may have been turned off by its owner.</p></div></div>;
  }
  const { page, rows } = q.data;
  const view = page.views[0] ?? { filters: [], sorts: [] };
  const shown = page.kind === 'database' ? applyView(rows, view, page.schema) : [];
  return (
    <div className="content" style={{ height: '100%' }}>
      <div className={`page${page.kind === 'database' ? ' wide' : ''}`}>
        {page.icon && <div className="page-icon-btn emoji">{page.icon}</div>}
        <h1 className="page-title">{page.title || 'Untitled'}</h1>
        {page.kind === 'database' ? (
          <div className="tbl-wrap"><table className="tbl" style={{ width: '100%' }}>
            <thead><tr><th><div className="th-btn">Name</div></th>{page.schema.map((p) => <th key={p.id}><div className="th-btn">{p.name}</div></th>)}</tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={r.id}><td><div className="cell"><b>{r.title || 'Untitled'}</b></div></td>
                {page.schema.map((p) => <td key={p.id}><div className="cell"><PropValueView prop={p} value={r.props[p.id] ?? null} users={[]} /></div></td>)}</tr>
            ))}</tbody>
          </table></div>
        ) : <ReadOnlyDoc page={page} token={token} />}
        <p className="subtle" style={{ marginTop: 60, display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/logo.svg" alt="" width={18} height={18} /> Published with Cairn
        </p>
      </div>
    </div>
  );
}
