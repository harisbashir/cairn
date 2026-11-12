import { CheckCircle2, CircleAlert, Cloud, Download, HardDrive, Loader2, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { BackupDestination, BackupDestinationType, BackupRun, BackupSettings } from '../../../shared/types.ts';
import { api, post, qc, uid } from '../api.ts';
import { Modal, Switch, useUi } from '../ui.tsx';
import { Code, fmtBytes, fmtDate, LoadNote, Loading, useAct } from './common.tsx';
import { useBackupRuns, useBackupSettings } from './hooks.ts';

type Schedule = Pick<BackupSettings, 'enabled' | 'frequency' | 'hour' | 'weekday' | 'keep'>;
type TestResult = { ok: boolean; message: string };

const TYPE_LABEL: Record<BackupDestinationType, string> = { local: 'This server', webdav: 'WebDAV', rclone: 'rclone' };
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'long' }));
const hourLabel = (h: number) => new Date(2023, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function summary(d: BackupDestination) {
  if (d.type === 'local') return 'In the backups folder of Cairn’s data directory';
  if (d.type === 'webdav') return d.config.url || 'No folder address';
  return d.config.remote || 'No remote path';
}

export function BackupsSection() {
  const settings = useBackupSettings();
  return (
    <>
      <h2>Backups</h2>
      <p className="muted">A backup is one zip with the whole database and every uploaded file. Keep copies somewhere other than this server so you can recover if its disk fails.</p>
      {settings.isPending && <Loading what="backup settings" />}
      {settings.isError && <LoadNote what="backup settings" error={settings.error} retry={() => settings.refetch()} />}
      {settings.data && (
        <>
          <ScheduleCard key={JSON.stringify(scheduleOf(settings.data))} settings={settings.data} />
          <Destinations settings={settings.data} />
        </>
      )}
      <History />
      <h3>Restoring</h3>
      <section>
        <p className="muted">Restore on the server with the command line. Cairn keeps the current data as <code className="st-code">cairn.db.before-restore</code> in case you need it back. Stop the server first, or add <code className="st-code">--force</code>.</p>
        <Code text="docker compose exec cairn node dist/server/src/cli.js restore <file>" label="Copy restore command" />
      </section>
    </>
  );
}

const scheduleOf = (s: BackupSettings): Schedule => ({ enabled: s.enabled, frequency: s.frequency, hour: s.hour, weekday: s.weekday, keep: s.keep });

async function save(settings: BackupSettings, change: Partial<BackupSettings>) {
  const next = await api<BackupSettings>('PUT', '/api/admin/backups/settings', { ...settings, ...change });
  qc.setQueryData(['admin', 'backup-settings'], next);
}

function ScheduleCard({ settings }: { settings: BackupSettings }) {
  const act = useAct();
  const [draft, setDraft] = useState<Schedule>(scheduleOf(settings));
  const dirty = JSON.stringify(draft) !== JSON.stringify(scheduleOf(settings));
  const set = (c: Partial<Schedule>) => setDraft((d) => ({ ...d, ...c }));
  return (
    <>
      <h3>Schedule</h3>
      <section className="st-card">
        <div className="row">
          <span className="grow"><b>Back up automatically</b><div className="subtle">Times use this server’s clock.</div></span>
          <Switch on={draft.enabled} onChange={(v) => set({ enabled: v })} label="Back up automatically" />
        </div>
        <div className={`st-grid${draft.enabled ? '' : ' st-dim'}`}>
          <label className="field"><span>How often</span>
            <select className="select" value={draft.frequency} disabled={!draft.enabled} onChange={(e) => set({ frequency: e.target.value as Schedule['frequency'] })}>
              <option value="hourly">Every hour</option><option value="daily">Every day</option><option value="weekly">Every week</option>
            </select>
          </label>
          {draft.frequency === 'weekly' && (
            <label className="field"><span>Day</span>
              <select className="select" value={draft.weekday} disabled={!draft.enabled} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          )}
          {draft.frequency !== 'hourly' && (
            <label className="field"><span>Time</span>
              <select className="select" value={draft.hour} disabled={!draft.enabled} onChange={(e) => set({ hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </label>
          )}
          <label className="field"><span>Keep the last</span>
            <span className="st-suffix">
              <input className="input" type="number" inputMode="numeric" min={1} max={1000} value={draft.keep} onChange={(e) => set({ keep: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} />
              <span className="subtle">backups</span>
            </span>
          </label>
        </div>
        <div className="row"><button className="btn primary" disabled={!dirty} onClick={() => act(() => save(settings, draft), 'Schedule saved')}>Save Schedule</button></div>
      </section>
    </>
  );
}

function TypeIcon({ type }: { type: BackupDestinationType }) {
  return type === 'local' ? <HardDrive size={16} aria-hidden /> : type === 'webdav' ? <Server size={16} aria-hidden /> : <Cloud size={16} aria-hidden />;
}

function TestNote({ result }: { result: TestResult | 'testing' | undefined }) {
  if (!result) return null;
  if (result === 'testing') return <span className="subtle st-inline" role="status"><Loader2 size={14} className="st-spin" aria-hidden />Testing…</span>;
  return (
    <span className={`st-inline ${result.ok ? 'st-ok' : 'err'}`} role="status">
      {result.ok ? <CheckCircle2 size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
      {result.ok ? 'Works. ' : 'Didn’t work. '}{result.message}
    </span>
  );
}

function Destinations({ settings }: { settings: BackupSettings }) {
  const ui = useUi();
  const act = useAct();
  const [editing, setEditing] = useState<BackupDestination | 'new' | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | 'testing'>>({});
  const test = async (d: BackupDestination) => {
    setTests((t) => ({ ...t, [d.id]: 'testing' }));
    try { const r = await post<TestResult>('/api/admin/backups/test', { destination: d }); setTests((t) => ({ ...t, [d.id]: r })); }
    catch (err) { setTests((t) => ({ ...t, [d.id]: { ok: false, message: (err as Error).message } })); }
  };
  return (
    <>
      <h3 className="st-h3">Destinations<span className="st-h3-actions"><button className="btn small" onClick={() => setEditing('new')}><Plus size={14} />Add Destination</button></span></h3>
      {settings.destinations.length === 0 && <p className="subtle">No destinations yet. Add one so backups have somewhere to go.</p>}
      {settings.destinations.length > 0 && (
        <ul className="st-list">
          {settings.destinations.map((d) => (
            <li key={d.id} className="st-list-row st-dest">
              <span className="st-type"><TypeIcon type={d.type} />{TYPE_LABEL[d.type]}</span>
              <span className="grow st-break">
                <b>{d.name}</b>
                <span className="subtle st-block">{summary(d)}</span>
                <TestNote result={tests[d.id]} />
              </span>
              <span className="st-row-actions">
                <button className="btn small" disabled={tests[d.id] === 'testing'} onClick={() => test(d)}>Test</button>
                <button className="icon-btn" aria-label={`Edit ${d.name}`} title="Edit" onClick={() => setEditing(d)}><Pencil size={15} /></button>
                <button className="icon-btn" aria-label={`Remove ${d.name}`} title="Remove" onClick={async () => {
                  if (await ui.confirm({ title: `Remove “${d.name}”?`, body: 'New backups stop going there. Backups already stored there are kept.', action: 'Remove Destination', danger: true })) {
                    act(() => save(settings, { destinations: settings.destinations.filter((x) => x.id !== d.id) }), 'Destination removed');
                  }
                }}><Trash2 size={15} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing && <DestinationDialog settings={settings} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

const CHOICES: { type: BackupDestinationType; title: string; help: string }[] = [
  { type: 'local', title: 'On this server', help: 'Quick to restore, but lost if the server’s disk fails.' },
  { type: 'webdav', title: 'Nextcloud / WebDAV', help: 'Nextcloud, ownCloud or any WebDAV folder.' },
  { type: 'rclone', title: 'Google Drive, Dropbox, OneDrive, S3…', help: 'Any cloud storage rclone supports.' },
];

function DestinationDialog({ settings, initial, onClose }: { settings: BackupSettings; initial: BackupDestination | null; onClose: () => void }) {
  const [type, setType] = useState<BackupDestinationType>(initial?.type ?? 'webdav');
  const [name, setName] = useState(initial?.name ?? '');
  const [config, setConfig] = useState<Record<string, string>>(initial?.config ?? {});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | 'testing'>();
  const saved = !!initial?.hasSecret && initial.type === type;
  const savedHint = 'Saved. Leave blank to keep it.';
  const field = (key: string) => ({ value: config[key] ?? '', onChange: (e: { target: { value: string } }) => { setConfig((c) => ({ ...c, [key]: e.target.value })); setResult(undefined); } });
  const rcloneMissing = type === 'rclone' && !settings.rcloneAvailable;
  const complete = !!name.trim() && (type === 'local'
    || (type === 'webdav' && !!config.url?.trim() && !!config.username?.trim() && (saved || !!config.password))
    || (type === 'rclone' && !rcloneMissing && !!config.remote?.trim() && (saved || !!config.config?.trim())));
  const keys: Record<BackupDestinationType, string[]> = { local: [], webdav: ['url', 'username', 'password'], rclone: ['remote', 'config'] };
  const destination = (): BackupDestination => ({
    id: initial?.id ?? uid(), type, name: name.trim(), hasSecret: saved,
    config: Object.fromEntries(keys[type].map((k) => [k, (config[k] ?? '').trim()])),
  });
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const d = destination();
      const list = initial ? settings.destinations.map((x) => (x.id === d.id ? d : x)) : [...settings.destinations, d];
      await save(settings, { destinations: list });
      onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const test = async () => {
    setResult('testing');
    try { setResult(await post<TestResult>('/api/admin/backups/test', { destination: destination() })); }
    catch (err) { setResult({ ok: false, message: (err as Error).message }); }
  };
  return (
    <Modal onClose={onClose} label={initial ? `Edit ${initial.name}` : 'Add a backup destination'} className="modal st-dialog st-dest-dialog">
      <h2>{initial ? 'Edit Destination' : 'Add a Destination'}</h2>
      <form className="st-form" onSubmit={(e) => { e.preventDefault(); if (complete) submit(); }}>
        {!initial && (
          <fieldset className="st-fieldset">
            <legend className="st-sr">Where to keep backups</legend>
            <div className="st-choices">
              {CHOICES.map((c) => (
                <label key={c.type} className={`st-choice${type === c.type ? ' on' : ''}`}>
                  <input type="radio" name="st-dest-type" value={c.type} checked={type === c.type} onChange={() => { setType(c.type); setResult(undefined); }} />
                  <TypeIcon type={c.type} />
                  <span><b>{c.title}</b><span className="subtle st-block">{c.help}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="field"><span>Name</span><input className="input" placeholder={type === 'local' ? 'This server' : type === 'webdav' ? 'Nextcloud' : 'Google Drive'} value={name} onChange={(e) => setName(e.target.value)} /></label>
        {type === 'local' && <p className="subtle">Backups are written to the <code className="st-code">backups</code> folder in Cairn’s data directory and can be downloaded from the history below.</p>}
        {type === 'webdav' && (
          <>
            <label className="field"><span>WebDAV folder address</span>
              <input className="input" type="url" inputMode="url" spellCheck={false} placeholder="https://cloud.example.com/remote.php/dav/files/USERNAME/Backups/Cairn/" {...field('url')} />
            </label>
            <label className="field"><span>Username</span><input className="input" autoComplete="off" spellCheck={false} {...field('username')} /></label>
            <label className="field"><span>App password</span>
              <input className="input" type="password" autoComplete="new-password" placeholder={saved ? savedHint : ''} {...field('password')} />
            </label>
            <p className="subtle">In Nextcloud, open Personal settings → Security and create an app password just for Cairn, so you can revoke it without changing your own password. Cairn creates the folder if it’s missing.</p>
          </>
        )}
        {type === 'rclone' && (
          <>
            {rcloneMissing && <div className="st-note" role="alert"><CircleAlert size={16} aria-hidden /><span className="grow">rclone isn’t installed on this server, so it can’t send backups there. Install rclone where Cairn runs, then come back.</span></div>}
            <ol className="st-steps">
              <li>Install rclone on any computer from <a href="https://rclone.org/install/" target="_blank" rel="noreferrer">rclone.org/install</a>.</li>
              <li>Run <code className="st-code">rclone config</code>, create a remote (for example named <code className="st-code">gdrive</code>) and sign in when it asks.</li>
              <li>Run <code className="st-code">rclone config show</code> and paste everything it prints below.</li>
            </ol>
            <label className="field"><span>Remote path</span><input className="input" spellCheck={false} placeholder="gdrive:Backups/Cairn" disabled={rcloneMissing} {...field('remote')} /></label>
            <label className="field"><span>rclone config</span>
              <textarea className="input st-textarea" spellCheck={false} rows={6} placeholder={saved ? savedHint : '[gdrive]\ntype = drive\ntoken = {…}'} disabled={rcloneMissing} {...field('config')} />
            </label>
          </>
        )}
        <TestNote result={result} />
        {error && <p className="err" role="alert">{error}</p>}
        <div className="actions st-actions">
          <button type="button" className="btn" disabled={!complete || result === 'testing'} onClick={test}>Test Connection</button>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!complete || busy}>{initial ? 'Save Destination' : 'Add Destination'}</button>
        </div>
      </form>
    </Modal>
  );
}

function RunResults({ run }: { run: BackupRun }): ReactNode {
  if (run.status === 'running') return <span className="st-inline subtle"><Loader2 size={14} className="st-spin" aria-hidden />Running…</span>;
  if (!run.results.length) return <span className={run.status === 'failed' ? 'err' : 'subtle'}>{run.status === 'failed' ? 'Failed' : 'No destinations'}</span>;
  return (
    <ul className="st-results">
      {run.results.map((r) => (
        <li key={r.destinationId} className={r.ok ? 'st-ok' : 'err'}>
          {r.ok ? <CheckCircle2 size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
          <span><b>{r.name}</b>: {r.ok ? 'OK' : `Failed. ${r.message}`}</span>
        </li>
      ))}
    </ul>
  );
}

function History() {
  const runs = useBackupRuns();
  const act = useAct();
  const running = !!runs.data?.some((r) => r.status === 'running');
  return (
    <>
      <h3 className="st-h3">History<span className="st-h3-actions">
        <button className="btn small primary" disabled={running || runs.isError} onClick={() => act(async () => { await post<BackupRun>('/api/admin/backups/run'); await runs.refetch(); }, 'Backup started')}>
          {running ? <Loader2 size={14} className="st-spin" aria-hidden /> : <Plus size={14} aria-hidden />}{running ? 'Backing Up…' : 'Back Up Now'}
        </button>
      </span></h3>
      {runs.isPending && <Loading what="backup history" />}
      {runs.isError && <LoadNote what="backup history" error={runs.error} retry={() => runs.refetch()} />}
      {runs.data?.length === 0 && <p className="subtle">No backups yet.</p>}
      {!!runs.data?.length && (
        <table className="stable st-cards"><thead><tr><th>Started</th><th>Trigger</th><th>Size</th><th>Result</th><th><span className="st-sr">Download</span></th></tr></thead><tbody>
          {runs.data.map((r) => (
            <tr key={r.id}>
              <td className="st-nowrap"><b>{fmtDate(r.startedAt)}</b></td>
              <td data-label="Trigger">{r.trigger === 'manual' ? 'Manual' : 'Scheduled'}</td>
              <td data-label="Size">{r.sizeBytes ? fmtBytes(r.sizeBytes) : '—'}</td>
              <td data-label="Result"><RunResults run={r} /></td>
              <td className="st-act">{r.downloadable && <a className="btn small" href={`/api/admin/backups/${r.id}/download`} download><Download size={14} />Download</a>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </>
  );
}
