import { Check } from 'lucide-react';
import { useState } from 'react';
import type { Accent, ThemeMode, UserPrefs } from '../../../shared/types.ts';
import { patch, qc } from '../api.ts';
import { useShell } from '../Shell.tsx';
import { applyPrefs, DEFAULT_PREFS } from '../theme.ts';
import { Avatar, useUi } from '../ui.tsx';
import { useAct } from './common.tsx';

export function Account() {
  const s = useShell();
  const act = useAct();
  const [name, setName] = useState(s.user.name);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  return (
    <>
      <h2>My Account</h2>
      <p className="muted">{s.user.email}</p>
      <h3>Profile</h3>
      <section>
        <div className="row st-wrap"><Avatar name={name} color={s.user.color} large />
          <label className="field grow"><span>Name</span><input className="input" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <div className="row">
          <button className="btn primary" disabled={!name.trim() || name === s.user.name} onClick={() => act(async () => { await patch('/api/me', { name: name.trim() }); await qc.invalidateQueries({ queryKey: ['bootstrap'] }); }, 'Name saved')}>Save Name</button>
        </div>
      </section>
      <h3>Password</h3>
      <section>
        <label className="field"><span>Current password</span><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
        <label className="field"><span>New password</span><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <div className="row st-wrap">
          <button className="btn" disabled={!cur || next.length < 8} onClick={async () => { if (await act(() => patch('/api/me', { currentPassword: cur, newPassword: next }), 'Password changed')) { setCur(''); setNext(''); } }}>Change Password</button>
          <span className="subtle">At least 8 characters.</span>
        </div>
      </section>
    </>
  );
}

const THEMES: { id: ThemeMode; label: string; help: string }[] = [
  { id: 'system', label: 'System', help: 'Follows your device' },
  { id: 'light', label: 'Light', help: 'Always light' },
  { id: 'dark', label: 'Dark', help: 'Always dark' },
];
const ACCENTS: { id: Accent; label: string }[] = [
  { id: 'blue', label: 'Blue' }, { id: 'violet', label: 'Violet' }, { id: 'green', label: 'Green' },
  { id: 'orange', label: 'Orange' }, { id: 'pink', label: 'Pink' }, { id: 'graphite', label: 'Graphite' },
];

function ThemePreview({ mode }: { mode: 'light' | 'dark' }) {
  return (
    <span className={`st-preview st-preview-${mode}`} aria-hidden>
      <span className="st-pv-side"><i /><i /><i /></span>
      <span className="st-pv-main"><b /><i /><i /><i className="short" /><em /></span>
    </span>
  );
}

export function Appearance() {
  const s = useShell();
  const ui = useUi();
  const [prefs, setPrefs] = useState<UserPrefs>({ ...DEFAULT_PREFS, ...s.user.prefs });
  const choose = async (change: Partial<UserPrefs>) => {
    const before = prefs;
    const next = { ...prefs, ...change };
    setPrefs(next);
    applyPrefs(next);
    try {
      await patch('/api/me', { prefs: change });
      await qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (err) {
      setPrefs(before);
      applyPrefs(before);
      ui.toast(`Your appearance wasn’t saved. ${(err as Error).message}`);
    }
  };
  return (
    <>
      <h2>Appearance</h2>
      <p className="muted">How Cairn looks for you on every device you sign in on. Other people aren’t affected.</p>

      <h3 id="st-theme-h">Theme</h3>
      <div className="st-themes" role="radiogroup" aria-labelledby="st-theme-h">
        {THEMES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={prefs.theme === t.id} className={`st-theme${prefs.theme === t.id ? ' on' : ''}`} onClick={() => choose({ theme: t.id })}>
            {t.id === 'system'
              ? <span className="st-preview-split"><ThemePreview mode="light" /><ThemePreview mode="dark" /></span>
              : <ThemePreview mode={t.id} />}
            <span className="st-theme-label">
              <span className="st-check" aria-hidden>{prefs.theme === t.id && <Check size={12} strokeWidth={3} />}</span>
              <span><b>{t.label}</b><span className="subtle">{t.help}</span></span>
            </span>
          </button>
        ))}
      </div>

      <h3 id="st-accent-h">Accent colour</h3>
      <p className="subtle st-help">Used for buttons, links and where you are in the sidebar.</p>
      <div className="st-accents" role="radiogroup" aria-labelledby="st-accent-h">
        {ACCENTS.map((a) => (
          <button key={a.id} type="button" role="radio" aria-checked={prefs.accent === a.id} className={`st-accent${prefs.accent === a.id ? ' on' : ''}`} onClick={() => choose({ accent: a.id })}>
            <span className="st-swatch" data-accent={a.id} aria-hidden>{prefs.accent === a.id && <Check size={14} strokeWidth={3} />}</span>
            {a.label}
          </button>
        ))}
      </div>
    </>
  );
}
