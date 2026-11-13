import { Link } from 'react-router-dom';
import type { Activity } from '../../../../shared/types.ts';
import { timeAgo, useActivity } from '../../api.ts';
import { AiTag } from '../../Home.tsx';
import { useShell } from '../../Shell.tsx';
import { num, type WidgetProps } from '../types.ts';
import { LoadError, SettingSelect, Settings, WidgetMessage } from './kit.tsx';

const VERB: Record<Activity['action'], string> = {
  created: 'created', updated: 'edited', deleted: 'moved to Trash', restored: 'restored', moved: 'moved', shared: 'shared', joined: 'joined the workspace', repeated: 'repeated', undone: 'undid a change on',
};

export function ActivityWidget({ widget, editing, onChange }: WidgetProps) {
  const s = useShell();
  const limit = num(widget.config.limit, 10);
  const activity = useActivity(s.wid, limit);
  return (
    <>
      {editing && (
        <Settings>
          <SettingSelect
            label="Show" value={String(limit)}
            options={[5, 10, 20].map((n) => ({ value: String(n), label: `${n} latest` }))}
            onChange={(v) => onChange({ ...widget.config, limit: Number(v) })}
          />
        </Settings>
      )}
      {activity.isError ? <LoadError what="Activity" /> : activity.data?.length === 0 ? (
        <WidgetMessage>Changes by you, your team and your AI agents show up here.</WidgetMessage>
      ) : (
        <div className="feed">
          {activity.data?.map((a) => {
            const body = (
              <>
                <span className="grow hm-ellipsis">
                  <b>{a.actorName}</b> {a.actorType === 'ai' && <AiTag />} <span className="muted">{VERB[a.action]}</span>{' '}
                  {a.pageId && <><span className="emoji">{a.pageIcon}</span> <b>{a.pageTitle || 'Untitled'}</b></>}
                </span>
                <span className="when">{timeAgo(a.at)}</span>
              </>
            );
            return a.pageId && a.action !== 'deleted'
              ? <Link key={a.id} className="feed-row" to={`/w/${s.wid}/p/${a.pageId}`}>{body}</Link>
              : <div key={a.id} className="feed-row">{body}</div>;
          })}
        </div>
      )}
    </>
  );
}
