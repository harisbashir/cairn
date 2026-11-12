import { usePage } from '../../api.ts';
import { EmbeddedDatabase } from '../../Database.tsx';
import { useShell } from '../../Shell.tsx';
import { num, str, type WidgetProps } from '../types.ts';
import { SettingSelect, Settings, WidgetMessage } from './kit.tsx';

const LIMITS = [5, 10, 25, 0];

export function ViewWidget({ widget, editing, onChange }: WidgetProps) {
  const s = useShell();
  const databaseId = str(widget.config.databaseId);
  const viewId = str(widget.config.viewId);
  const limit = num(widget.config.limit, 10);
  const databases = (s.tree?.nodes ?? []).filter((n) => n.kind === 'database');
  const db = usePage(editing && databaseId ? databaseId : undefined);
  return (
    <>
      {editing && (
        <Settings>
          <SettingSelect
            label="Database" wide value={databaseId}
            options={[{ value: '', label: databases.length ? 'Choose a database…' : 'No databases yet' }, ...databases.map((d) => ({ value: d.id, label: `${d.icon ? `${d.icon} ` : ''}${d.title || 'Untitled'}` }))]}
            onChange={(v) => onChange({ ...widget.config, databaseId: v, viewId: '' })}
          />
          {databaseId && (
            <SettingSelect
              label="View" value={viewId}
              options={[{ value: '', label: 'First view' }, ...(db.data?.views ?? []).map((v) => ({ value: v.id, label: v.name }))]}
              onChange={(v) => onChange({ ...widget.config, viewId: v })}
            />
          )}
          <SettingSelect
            label="Rows" value={String(limit)}
            options={LIMITS.map((n) => ({ value: String(n), label: n ? `Up to ${n}` : 'All' }))}
            onChange={(v) => onChange({ ...widget.config, limit: Number(v) })}
          />
        </Settings>
      )}
      {databaseId
        ? <div className="hm-embed"><EmbeddedDatabase databaseId={databaseId} viewId={viewId || undefined} limit={limit || undefined} /></div>
        : <WidgetMessage>{editing ? 'Choose a database to show one of its views here.' : 'No database chosen yet. Select Customize to pick one.'}</WidgetMessage>}
    </>
  );
}
