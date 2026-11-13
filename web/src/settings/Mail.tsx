import { Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MailSettings } from '../../../shared/types.ts';
import { api, post, qc } from '../api.ts';
import { useMailSettings } from '../inbox/hooks.ts';
import { useShell } from '../Shell.tsx';
import { Switch, useUi } from '../ui.tsx';
import { LoadNote, Loading, useAct } from './common.tsx';

/** Server: outgoing email (SMTP) for notification emails. */
export function MailSection() {
  const s = useShell();
  const ui = useUi();
  const act = useAct();
  const mail = useMailSettings();
  const [form, setForm] = useState<MailSettings | null>(null);
  const [password, setPassword] = useState('');
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (mail.data && !form) setForm(mail.data); }, [mail.data, form]);

  if (mail.isPending) return <><h2>Email</h2><Loading what="email settings" /></>;
  if (mail.isError || !form) return <><h2>Email</h2><LoadNote what="email settings" error={mail.error} retry={() => mail.refetch()} /></>;

  const set = (change: Partial<MailSettings>) => setForm({ ...form, ...change });
  const dirty = password !== '' || (Object.keys(form) as (keyof MailSettings)[]).some((k) => k !== 'password' && form[k] !== mail.data[k]);
  const valid = !form.enabled || (form.host.trim() && form.port > 0 && form.from.trim());
  const save = () => act(async () => {
    const saved = await api<MailSettings>('PUT', '/api/admin/mail', {
      enabled: form.enabled, host: form.host.trim(), port: form.port, secure: form.secure,
      username: form.username.trim(), from: form.from.trim(), ...(password ? { password } : {}),
    });
    qc.setQueryData(['admin', 'mail'], saved);
    setForm(saved);
    setPassword('');
  }, 'Email settings saved');

  return (
    <>
      <h2>Email</h2>
      <p className="muted">The mail server Cairn sends notification emails through. People choose in Settings › Notifications whether they get email.</p>

      <section>
        <div className="row">
          <span className="grow"><b>Send notification emails</b><div className="subtle">Off: Cairn sends no email at all.</div></span>
          <Switch on={form.enabled} onChange={(v) => set({ enabled: v })} label="Send notification emails" />
        </div>
      </section>

      <h3>SMTP server</h3>
      <section className="st-mail">
        <div className="row st-end">
          <label className="field grow"><span>Host</span><input className="input" value={form.host} placeholder="smtp.example.com" onChange={(e) => set({ host: e.target.value })} autoComplete="off" /></label>
          <label className="field st-port"><span>Port</span><input className="input" inputMode="numeric" value={form.port || ''} placeholder="587" onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></label>
        </div>
        <div className="row">
          <span className="grow"><b>Use TLS from the start</b><div className="subtle">On for port 465. Off uses STARTTLS, usual for port 587.</div></span>
          <Switch on={form.secure} onChange={(v) => set({ secure: v, ...(v && form.port === 587 ? { port: 465 } : !v && form.port === 465 ? { port: 587 } : {}) })} label="Use TLS from the start" />
        </div>
        <div className="row st-end">
          <label className="field grow"><span>Username</span><input className="input" value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" /></label>
          <label className="field grow">
            <span>Password</span>
            <input className="input" type="password" value={password} placeholder={form.hasPassword ? 'Saved; type to replace' : ''} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
        <label className="field"><span>From</span><input className="input" value={form.from} placeholder="Cairn <cairn@example.com>" onChange={(e) => set({ from: e.target.value })} /></label>
      </section>

      <div className="row st-mail-acts">
        <button className="btn" disabled={testing || dirty || !mail.data.enabled} title={dirty ? 'Save first' : undefined} onClick={async () => {
          setTesting(true);
          try {
            const r = await post<{ ok: boolean; message: string }>('/api/admin/mail/test');
            ui.toast(r.ok ? `Test email sent to ${s.user.email}` : r.message);
          } catch (err) { ui.toast((err as Error).message); }
          setTesting(false);
        }}><Send size={14} />{testing ? 'Sending…' : 'Send Test Email'}</button>
        <span className="grow" />
        {dirty && <button className="btn ghost" onClick={() => { setForm(mail.data); setPassword(''); }}>Discard</button>}
        <button className="btn primary" disabled={!dirty || !valid} onClick={save}>Save</button>
      </div>
    </>
  );
}
