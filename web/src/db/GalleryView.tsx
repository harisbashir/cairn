import { FileText, Filter as FilterIcon, Plus } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Row } from '../../../shared/types.ts';
import { CardMeta, markerColor, type Db } from './kit.tsx';
import './views.css';

/** A row's cover when it is an image we can show (covers may also be gradient keys, which cards skip). */
export function coverImage(row: Row): string {
  const cover = row.cover ?? '';
  return /^(https?:|\/|data:image\/)/.test(cover) ? cover : '';
}

export function GalleryView({ db }: { db: Db }) {
  const navigate = useNavigate();
  const showCover = db.view.cover !== 'none';
  const add = async () => {
    const row = await db.addRow();
    if (row) navigate(db.rowHref(row.id));
  };

  if (!db.shown.length && !db.canEdit) {
    return <div className="empty"><FilterIcon size={20} />No rows{db.rows.length ? ' match this view' : ' yet'}.</div>;
  }
  return (
    <div className={`gv-grid${showCover ? '' : ' no-cover'}`}>
      {db.shown.map((row) => <Card key={row.id} row={row} db={db} showCover={showCover} />)}
      {db.canEdit && (
        <button type="button" className="gv-new" onClick={add}>
          <Plus size={18} aria-hidden />New
        </button>
      )}
    </div>
  );
}

function Card({ row, db, showCover }: { row: Row; db: Db; showCover: boolean }) {
  const img = coverImage(row);
  const preview = (row.preview ?? '').trim();
  return (
    <Link to={db.rowHref(row.id)} className="gv-card">
      {showCover && (
        <div className="gv-cover" style={img ? undefined : ({ '--gv-tint': `var(--o-${markerColor(row.id)}-bg)` } as CSSProperties)}>
          {img
            ? <img src={img} alt="" loading="lazy" decoding="async" />
            : <span className="gv-ph emoji" aria-hidden>{row.icon || <FileText size={30} strokeWidth={1.5} />}</span>}
        </div>
      )}
      <div className="gv-body">
        <span className="gv-title">
          {!showCover && row.icon && <span className="emoji ico" aria-hidden>{row.icon}</span>}
          {row.title || 'Untitled'}
        </span>
        <CardMeta row={row} db={db} />
        {preview && <p className="gv-preview">{preview}</p>}
      </div>
    </Link>
  );
}
