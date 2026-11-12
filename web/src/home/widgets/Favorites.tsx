import { Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageIcon, useShell } from '../../Shell.tsx';
import { WidgetMessage } from './kit.tsx';

export function FavoritesWidget() {
  const s = useShell();
  if (!s.tree) return null;
  const byId = new Map(s.tree.nodes.map((n) => [n.id, n]));
  const pages = s.tree.favorites.map((id) => byId.get(id)).filter((n) => n !== undefined);
  if (pages.length === 0) {
    return (
      <WidgetMessage>
        <Star size={18} aria-hidden />
        No favourites yet. Open a page and select the star in its top bar to pin it here.
      </WidgetMessage>
    );
  }
  return (
    <div className="feed">
      {pages.map((n) => (
        <Link key={n.id} className="feed-row hm-compact" to={`/w/${s.wid}/p/${n.id}`}>
          <PageIcon icon={n.icon} kind={n.kind} />
          <span className="grow hm-ellipsis">{n.title || 'Untitled'}</span>
        </Link>
      ))}
    </div>
  );
}
