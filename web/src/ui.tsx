import {
  autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, useClick, useDismiss, useFloating,
  useInteractions, useRole, type Placement,
} from '@floating-ui/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

// ---------- Popover / menu ----------
const CloseCtx = createContext<() => void>(() => {});
export const useClose = () => useContext(CloseCtx);

export function Popover({
  trigger, children, placement = 'bottom-start', className = 'menu', open: controlled, onOpenChange,
}: {
  trigger: (props: Record<string, unknown>, open: boolean) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  placement?: Placement;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const setOpen = useCallback((v: boolean) => { setInner(v); onOpenChange?.(v); }, [onOpenChange]);
  const { refs, floatingStyles, context } = useFloating({
    open, onOpenChange: setOpen, placement, whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context), useRole(context)]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const phone = useIsPhone();
  return (
    <>
      {trigger({ ref: refs.setReference, ...getReferenceProps() }, open)}
      {open && (
        <FloatingPortal>
          {phone && <div className="sheet-backdrop" />}
          <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
            <div ref={refs.setFloating} style={phone ? undefined : floatingStyles} className={phone ? `${className} sheet` : className} {...getFloatingProps()}>
              {phone && <div className="sheet-grabber" aria-hidden />}
              <CloseCtx.Provider value={close}>{typeof children === 'function' ? children(close) : children}</CloseCtx.Provider>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

export function MenuItem({
  icon, children, hint, danger, onClick, keepOpen, active,
}: { icon?: ReactNode; children: ReactNode; hint?: ReactNode; danger?: boolean; onClick?: () => void; keepOpen?: boolean; active?: boolean }) {
  const close = useClose();
  return (
    <button
      type="button"
      className={`menu-item${danger ? ' danger' : ''}${active ? ' active' : ''}`}
      onClick={() => { onClick?.(); if (!keepOpen) close(); }}
    >
      {icon}
      <span className="grow">{children}</span>
      {hint && <span className="hint">{hint}</span>}
    </button>
  );
}

// ---------- Modal ----------
export function Modal({ children, onClose, className = 'modal', label }: { children: ReactNode; onClose: () => void; className?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, button');
    first?.focus();
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <FloatingPortal>
      <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div ref={ref} className={className} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
      </div>
    </FloatingPortal>
  );
}

// ---------- Confirm + toast ----------
interface ConfirmOpts { title: string; body?: string; action: string; danger?: boolean }
interface ToastMsg { id: number; text: string; undo?: () => void }
const UiCtx = createContext<{ confirm: (o: ConfirmOpts) => Promise<boolean>; toast: (text: string, undo?: () => void) => void }>(null!);
export const useUi = () => useContext(UiCtx);

export function UiProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const value = useMemo(() => ({
    confirm: (o: ConfirmOpts) => new Promise<boolean>((resolve) => setAsk({ ...o, resolve })),
    toast: (text: string, undo?: () => void) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-2), { id, text, undo }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), undo ? 7000 : 3500);
    },
  }), []);
  // Lets non-React code (editor plugins) show a toast.
  useEffect(() => {
    const on = (e: Event) => value.toast(String((e as CustomEvent).detail));
    window.addEventListener('cairn:toast', on);
    return () => window.removeEventListener('cairn:toast', on);
  }, [value]);
  const answer = (v: boolean) => { ask?.resolve(v); setAsk(null); };
  return (
    <UiCtx.Provider value={value}>
      {children}
      {ask && (
        <Modal onClose={() => answer(false)} label={ask.title}>
          <h2>{ask.title}</h2>
          {ask.body && <p className="muted">{ask.body}</p>}
          <div className="actions">
            <button className="btn" onClick={() => answer(false)}>Cancel</button>
            <button className={`btn ${ask.danger ? 'danger' : 'primary'}`} onClick={() => answer(true)}>{ask.action}</button>
          </div>
        </Modal>
      )}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
            {t.undo && <button onClick={() => { t.undo!(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>Undo</button>}
          </div>
        ))}
      </div>
    </UiCtx.Provider>
  );
}

// ---------- Bits ----------
export function Avatar({ name, color, large }: { name: string; color: string; large?: boolean }) {
  return <span className={`avatar${large ? ' large' : ''}`} style={{ background: color }} aria-hidden>{name.trim().slice(0, 1) || '?'}</span>;
}

export function WsBadge({ name, icon, color }: { name: string; icon: string; color: string }) {
  return <span className="ws-badge emoji" style={{ background: icon ? 'transparent' : color, fontSize: icon ? 18 : 13 }} aria-hidden>{icon || name.trim().slice(0, 1).toUpperCase()}</span>;
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} />;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button" className="icon-btn" aria-label={label} title={label}
      onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

export const EMOJI = '📄 📝 📒 📚 📌 📎 🗂️ 🗒️ ✅ ☑️ 🎯 🚀 💡 🧠 🔥 ⭐ ❤️ 🏠 💼 🧰 🛠️ ⚙️ 🧪 🔬 📊 📈 💰 🧾 🗓️ ⏰ 🌱 🌍 ☀️ 🌙 ⛰️ 🪨 🧭 🗺️ 🏕️ 🎨 🎬 🎵 📷 🍽️ ☕ 🏋️ ✈️ 🚗 🛒 🎁 👋 👥 🤝 🤖 💬 📣 🔒 🔑 🐛 💻 📱 🌐 🧩 🏆'.split(' ');

export function EmojiPicker({ onPick, allowRemove }: { onPick: (emoji: string) => void; allowRemove?: boolean }) {
  const close = useClose();
  return (
    <div>
      <div className="emoji-grid emoji">
        {EMOJI.map((e) => <button key={e} type="button" aria-label={e} onClick={() => { onPick(e); close(); }}>{e}</button>)}
      </div>
      {allowRemove && (<><div className="menu-sep" /><MenuItem onClick={() => onPick('')}>Remove icon</MenuItem></>)}
    </div>
  );
}

export const WS_COLORS = ['#4263eb', '#7048e8', '#ae3ec9', '#d6336c', '#e8590c', '#f08c00', '#2f9e44', '#0c8599', '#495057'];

// ---------- Screen size ----------
const phoneQuery = typeof window !== 'undefined' ? window.matchMedia('(max-width: 760px)') : null;
/** True on phone-sized screens. Layouts switch on available width, not on device type. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => !!phoneQuery?.matches);
  useEffect(() => {
    if (!phoneQuery) return;
    const on = () => setPhone(phoneQuery.matches);
    phoneQuery.addEventListener('change', on);
    return () => phoneQuery.removeEventListener('change', on);
  }, []);
  return phone;
}
