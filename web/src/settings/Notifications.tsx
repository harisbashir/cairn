import { BellOff, Send, Smartphone, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { NotifyPrefs, PushSubscriptionInfo, UserPrefs } from '../../../shared/types.ts';
import { del, get, patch, post, qc, timeAgo } from '../api.ts';
import { usePushDevices } from '../inbox/hooks.ts';
import { useShell } from '../Shell.tsx';
import { Switch, useUi } from '../ui.tsx';
import { LoadNote, Loading, useAct } from './common.tsx';

const DEVICE_KEY = 'cairn.pushDevice';

export const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this device';
  return `${browser} on ${os}`;
}

function keyBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  // Production registers the worker on load; in development (or if that failed) register it now.
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (!existing) await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

/** Subscribes this browser to push and tells the server. */
async function enablePush() {
  const permission = await window.Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for Cairn in this browser’s settings.' : 'Notifications weren’t allowed.');
  const reg = await registration();
  const { publicKey } = await get<{ publicKey: string }>('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const info = await post<PushSubscriptionInfo>('/api/push/subscriptions', { subscription: sub.toJSON(), device: deviceName() });
  localStorage.setItem(DEVICE_KEY, info.id);
  return info;
}

async function disablePush(id: string | null) {
  if (id) await del(`/api/push/subscriptions/${id}`);
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe().catch(() => {});
  localStorage.removeItem(DEVICE_KEY);
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }));

export function NotificationsSection() {
  const s = useShell();
  const ui = useUi();
  const act = useAct();
  const devices = usePushDevices();
  const [prefs, setPrefs] = useState<UserPrefs>(s.user.prefs);
  const [busy, setBusy] = useState(false);
  const thisDevice = localStorage.getItem(DEVICE_KEY);
  const subscribedHere = !!thisDevice && !!devices.data?.some((d) => d.id === thisDevice);
  const zones = useMemo(() => {
    let list: string[] = [];
    try { list = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { /* old browser */ }
    if (!list.includes('UTC')) list = ['UTC', ...list];
    if (!list.includes(prefs.timezone)) list = [prefs.timezone, ...list];
    return list;
  }, [prefs.timezone]);
  const here = browserZone();

  const save = async (change: Partial<UserPrefs>, notify?: Partial<NotifyPrefs>) => {
    const before = prefs;
    setPrefs({ ...prefs, ...change, notify: { ...prefs.notify, ...notify } });
    try {
      await patch('/api/me', { prefs: notify ? { ...change, notify } : change });
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (err) {
      setPrefs(before);
      ui.toast(`That wasn’t saved. ${(err as Error).message}`);
    }
  };
  const refreshDevices = () => qc.invalidateQueries({ queryKey: ['push', 'devices'] });

  const supported = pushSupported();
  const iosNeedsInstall = !supported && isIos();
  const blocked = supported && window.Notification.permission === 'denied';

  return (
    <>
      <h2>Notifications</h2>
      <p className="muted">Cairn tells you about mentions, replies, assignments and reminders in the bell. Choose what else reaches you, and where.</p>

      <h3>This device</h3>
      {!supported ? (
        <div className="st-note" role="status">
          <BellOff size={16} aria-hidden />
          <span className="grow">
            {iosNeedsInstall
              ? <>On iPhone and iPad, push works once Cairn is on your Home Screen (iOS 16.4 or later). In Safari, tap Share, then <b>Add to Home Screen</b>, and open Cairn from there.</>
              : 'This browser can’t receive push notifications. You still see everything in the bell.'}
          </span>
        </div>
      ) : (
        <div className="row">
          <Smartphone size={18} className="subtle" aria-hidden />
          <span className="grow">
            <b>{subscribedHere ? 'Push is on for this device' : 'Push notifications on this device'}</b>
            <div className="subtle">
              {blocked ? 'Notifications are blocked for Cairn. Allow them in this browser’s site settings, then try again.'
                : subscribedHere ? deviceName()
                : isIos() && !standalone() ? 'Open Cairn from your Home Screen to turn on push.'
                : 'Get reminders and mentions even when Cairn isn’t open.'}
            </div>
          </span>
          {subscribedHere ? (
            <button className="btn" disabled={busy} onClick={async () => {
              setBusy(true);
              await act(async () => { await disablePush(thisDevice); refreshDevices(); }, 'Push turned off for this device');
              setBusy(false);
            }}>Turn Off</button>
          ) : (
            <button className="btn primary" disabled={busy || blocked} onClick={async () => {
              setBusy(true);
              await act(async () => { await enablePush(); refreshDevices(); }, 'Push is on for this device');
              setBusy(false);
            }}>{busy ? 'Turning On…' : 'Turn On'}</button>
          )}
        </div>
      )}

      <h3 className="st-h3">
        My devices
        {!!devices.data?.length && (
          <span className="st-h3-actions">
            <button className="btn small" onClick={() => act(async () => {
              const r = await post<{ ok: boolean; message: string }>('/api/push/test');
              ui.toast(r.message);
            })}><Send size={14} />Send Test Notification</button>
          </span>
        )}
      </h3>
      {devices.isPending && <Loading what="devices" />}
      {devices.isError && <LoadNote what="your devices" error={devices.error} retry={() => devices.refetch()} />}
      {devices.data?.length === 0 && <p className="subtle">No devices get push notifications yet.</p>}
      {!!devices.data?.length && (
        <div className="st-list">
          {devices.data.map((d) => (
            <div key={d.id} className="st-list-row">
              <Smartphone size={16} className="subtle" aria-hidden />
              <span className="grow"><b>{d.device || 'Unknown device'}</b>{d.id === thisDevice && <span className="subtle"> (this device)</span>}<div className="subtle">Added {timeAgo(d.createdAt)}</div></span>
              <button className="icon-btn" aria-label={`Remove ${d.device}`} title="Remove device" onClick={() => act(async () => {
                if (d.id === thisDevice) await disablePush(d.id); else await del(`/api/push/subscriptions/${d.id}`);
                refreshDevices();
              }, 'Device removed')}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}

      <h3>Send me</h3>
      <section>
        <div className="row">
          <span className="grow"><b>Push notifications</b><div className="subtle">On the devices above.</div></span>
          <Switch on={prefs.notify.push} onChange={(v) => save({}, { push: v })} label="Push notifications" />
        </div>
        <div className="row">
          <span className="grow"><b>Email</b><div className="subtle">To {s.user.email}. Needs email set up by the server administrator.</div></span>
          <Switch on={prefs.notify.email} onChange={(v) => save({}, { email: v })} label="Email notifications" />
        </div>
      </section>

      <h3>Notify me about</h3>
      <section>
        <div className="row">
          <span className="grow"><b>Mentions</b><div className="subtle">Someone writes @{s.user.name} in a page or comment.</div></span>
          <Switch on={prefs.notify.mentions} onChange={(v) => save({}, { mentions: v })} label="Mentions" />
        </div>
        <div className="row">
          <span className="grow"><b>Comments</b><div className="subtle">Replies to your threads, and comments on pages you created.</div></span>
          <Switch on={prefs.notify.comments} onChange={(v) => save({}, { comments: v })} label="Comments" />
        </div>
        <div className="row">
          <span className="grow"><b>Assignments</b><div className="subtle">Someone adds you to a person property.</div></span>
          <Switch on={prefs.notify.assigned} onChange={(v) => save({}, { assigned: v })} label="Assignments" />
        </div>
        <div className="row">
          <span className="grow"><b>Reminders</b><div className="subtle">Always on. Set reminders from a page’s ⋯ menu or a date property.</div></span>
        </div>
      </section>

      <h3>Time</h3>
      <section>
        <div className="row st-end">
          <label className="field grow">
            <span>Time zone</span>
            <select className="select" value={prefs.timezone} onChange={(e) => save({ timezone: e.target.value })}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          {prefs.timezone !== here && <button className="btn" onClick={() => save({ timezone: here })}>Use {here.replace(/_/g, ' ')}</button>}
        </div>
        <div className="row st-end">
          <label className="field grow">
            <span>Reminders for dates without a time arrive at</span>
            <select className="select" value={prefs.reminderHour} onChange={(e) => save({ reminderHour: Number(e.target.value) })}>
              {HOURS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
            </select>
          </label>
        </div>
      </section>
    </>
  );
}
