import type { UserPrefs } from '../../shared/types.ts';

export const DEFAULT_PREFS: UserPrefs = { theme: 'system', accent: 'blue' };

/** Applies appearance preferences to the document. 'system' follows the device setting. */
export function applyPrefs(prefs: Partial<UserPrefs> | undefined): void {
  const p = { ...DEFAULT_PREFS, ...prefs };
  const root = document.documentElement;
  if (p.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', p.theme);
  if (p.accent === 'blue') root.removeAttribute('data-accent'); else root.setAttribute('data-accent', p.accent);
  localStorage.setItem('cairn.prefs', JSON.stringify(p));
}

/** Called before React mounts so the first paint already has the right colours. */
export function applyStoredPrefs(): void {
  try { applyPrefs(JSON.parse(localStorage.getItem('cairn.prefs') ?? '{}')); } catch { /* first visit */ }
}
