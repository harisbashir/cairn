import { useShell } from '../../Shell.tsx';
import { useStats } from '../hooks.ts';
import { LoadError } from './kit.tsx';

export function StatsWidget() {
  const s = useShell();
  const stats = useStats(s.wid);
  if (stats.isError) return <LoadError what="Workspace numbers" />;
  if (!stats.data) return null;
  const d = stats.data;
  const tiles: [number, string][] = [
    [d.pages, d.pages === 1 ? 'Page' : 'Pages'],
    [d.databases, d.databases === 1 ? 'Database' : 'Databases'],
    [d.rows, d.rows === 1 ? 'Row' : 'Rows'],
    [d.members, d.members === 1 ? 'Member' : 'Members'],
    [d.editsThisWeek, 'Edits this week'],
    [d.aiEditsThisWeek, 'AI edits this week'],
  ];
  return (
    <div className="stat-grid hm-stats">
      {tiles.map(([n, label]) => <div key={label} className="stat"><b>{n.toLocaleString()}</b><span>{label}</span></div>)}
    </div>
  );
}
