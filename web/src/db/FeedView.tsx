import { Newspaper } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Row } from '../../../shared/types.ts';
import { timeAgo } from '../api.ts';
import { Avatar } from '../ui.tsx';
import { coverImage } from './GalleryView.tsx';
import { CardMeta, type Db } from './kit.tsx';
import './views.css';

export function FeedView({ db }: { db: Db }) {
  // Newest first, unless the view has its own sort order.
  const posts = db.view.sorts.length ? db.shown : [...db.shown].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="fd">
      {db.canEdit && <Composer db={db} />}
      {posts.map((row) => <Post key={row.id} row={row} db={db} />)}
      {!posts.length && <div className="empty"><Newspaper size={20} />{db.rows.length ? 'No posts match this view.' : 'No posts yet.'}</div>}
    </div>
  );
}

function Composer({ db }: { db: Db }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    const row = await db.addRow();
    if (row) { db.patchRow(row.id, { title }); setText(''); }
    setBusy(false);
  };
  return (
    <form className="fd-composer" onSubmit={submit}>
      <input className="input" placeholder="Post an update…" aria-label="Post an update" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn primary" type="submit" disabled={!text.trim() || busy}>Post</button>
    </form>
  );
}

function Post({ row, db }: { row: Row; db: Db }) {
  const author = row.createdByName ?? '';
  const user = db.users.find((u) => u.id === row.createdBy);
  const img = coverImage(row);
  const preview = (row.preview ?? '').trim();
  return (
    <article className="fd-post" aria-labelledby={`fd-${row.id}`}>
      <header className="fd-by">
        <Avatar name={author || '?'} color={user?.color ?? 'var(--text-3)'} />
        <span className="fd-author">{author || 'Someone'}</span>
        <time className="fd-when" dateTime={row.createdAt} title={new Date(row.createdAt).toLocaleString()}>{timeAgo(row.createdAt)}</time>
        {row.updatedByType === 'ai' && <span className="ai-tag" title="Last edited by an AI agent">AI</span>}
      </header>
      <h2 className="fd-title" id={`fd-${row.id}`}>
        <Link to={db.rowHref(row.id)}>{row.icon && <span className="emoji fd-icon" aria-hidden>{row.icon}</span>}{row.title || 'Untitled'}</Link>
      </h2>
      {preview && <p className="fd-text">{preview}</p>}
      {img && <img className="fd-cover" src={img} alt="" loading="lazy" decoding="async" />}
      <CardMeta row={row} db={db} />
    </article>
  );
}
