import { Link } from 'react-router-dom';
import { timeAgo, useRecent } from '../../api.ts';
import { PageIcon, useShell } from '../../Shell.tsx';
import { LoadError, WidgetMessage } from './kit.tsx';

export function RecentWidget() {
  const s = useShell();
  const recent = useRecent(s.wid);
  if (recent.isError) return <LoadError what="Recent pages" />;
  if (recent.data?.length === 0) return <WidgetMessage>Nothing here yet. Start with a page, or a database to track things.</WidgetMessage>;
  return (
    <div className="cards hm-cards">
      {recent.data?.map((p) => (
        <Link key={p.id} className="card" to={`/w/${s.wid}/p/${p.id}`}>
          <span className="ico emoji">{p.icon || <PageIcon icon="" kind={p.kind} size={22} />}</span>
          <span>
            <div className="t">{p.title || 'Untitled'}</div>
            <div className="m">{p.path ? `${p.path} · ` : ''}{timeAgo(p.updatedAt)}</div>
          </span>
        </Link>
      ))}
    </div>
  );
}
