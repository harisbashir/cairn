import { Link } from 'react-router-dom';
import { timeAgo } from '../api.ts';
import { LoadError, SettingSelect, Settings, WidgetMessage } from '../home/widgets/kit.tsx';
import { num, type WidgetProps } from '../home/types.ts';
import { useShell } from '../Shell.tsx';
import { actorLabel, ChangeLine } from './Changes.tsx';
import { useLatestChanges, useNotifications } from './hooks.ts';
import { NotificationRow, UpcomingReminders, useOpenNotification } from './Notifications.tsx';
import './inbox.css';

const limitSetting = (widget: WidgetProps['widget'], onChange: WidgetProps['onChange'], limit: number) => (
  <Settings>
    <SettingSelect
      label="Show" value={String(limit)}
      options={[3, 5, 10].map((n) => ({ value: String(n), label: `${n} latest` }))}
      onChange={(v) => onChange({ ...widget.config, limit: Number(v) })}
    />
  </Settings>
);

/** Home: my unread notifications, then the next reminders. */
export function NotificationsWidget({ widget, editing, onChange }: WidgetProps) {
  const s = useShell();
  const limit = num(widget.config.limit, 5);
  const list = useNotifications({ unread: true, limit });
  const open = useOpenNotification();
  return (
    <>
      {editing && limitSetting(widget, onChange, limit)}
      {list.isError ? <LoadError what="Notifications" /> : list.data?.length === 0 ? (
        <WidgetMessage>No unread notifications. Mentions, replies and reminders show up here.</WidgetMessage>
      ) : (
        <div className="feed inb-wfeed">
          {list.data?.map((n) => <NotificationRow key={n.id} n={n} onOpen={(x) => open(x)} compact />)}
        </div>
      )}
      <div className="inb-w-sub">Upcoming reminders</div>
      <UpcomingReminders wid={s.wid} limit={3} compact />
    </>
  );
}

export function NotificationsAction() {
  const s = useShell();
  return <Link className="btn ghost small" to={`/w/${s.wid}/notifications`}>See All</Link>;
}

/** Home: the latest AI changes, linking to the review screen. */
export function ChangesWidget({ widget, editing, onChange }: WidgetProps) {
  const s = useShell();
  const limit = num(widget.config.limit, 5);
  const changes = useLatestChanges(s.wid, limit);
  return (
    <>
      {editing && limitSetting(widget, onChange, limit)}
      {changes.isError ? <LoadError what="AI changes" /> : changes.data?.length === 0 ? (
        <WidgetMessage>When an AI agent changes something through MCP, it shows up here and can be undone.</WidgetMessage>
      ) : (
        <div className="feed inb-wfeed">
          {changes.data?.map((c) => (
            <div key={c.id} className={`feed-row inb-wchange${c.undoneAt ? ' undone' : ''}`} title={`${actorLabel(c)}: ${c.fields.join(', ')}`}>
              <span className="grow hm-ellipsis"><ChangeLine c={c} compact /></span>
              <span className="when">{c.undoneAt ? 'Undone' : timeAgo(c.at)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function ChangesAction() {
  const s = useShell();
  return <Link className="btn ghost small" to={`/w/${s.wid}/changes`}>Review</Link>;
}
