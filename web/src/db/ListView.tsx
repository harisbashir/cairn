import { Filter as FilterIcon, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageIcon } from '../Shell.tsx';
import { CardMeta, type Db } from './kit.tsx';

export function ListView({ db }: { db: Db }) {
  return (
    <div className="list">
      {db.shown.map((r) => (
        <Link key={r.id} className="list-row" to={db.rowHref(r.id)}>
          <PageIcon icon={r.icon} kind="page" /><span className="t">{r.title || 'Untitled'}</span><CardMeta row={r} db={db} />
        </Link>
      ))}
      {db.shown.length === 0 && <div className="empty"><FilterIcon size={20} />No rows{db.rows.length ? ' match this view' : ' yet'}.</div>}
      {db.canEdit && <button className="add-row" onClick={() => db.addRow()}><Plus size={15} />New row</button>}
    </div>
  );
}
