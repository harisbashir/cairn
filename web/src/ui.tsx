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
  const phone = useIsPhone();
  // On phones the sheet's backdrop closes it on click. Closing on pointerdown (the default) would let the same tap
  // land on whatever was under the backdrop, opening a card behind the sheet.
  const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context, { outsidePress: !phone }), useRole(context)]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  return (
    <>
      {trigger({ ref: refs.setReference, ...getReferenceProps() }, open)}
      {open && (
        <FloatingPortal>
          {phone && <div className="sheet-backdrop" onClick={close} aria-hidden />}
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
/**
 * Lets the browser/phone Back gesture close an open layer instead of leaving the page. Opening pushes a marker
 * history entry; Back pops it and closes the layer; closing any other way pops the marker. Layers that hand over
 * to each other (palette -> settings) share one marker, and a layer that navigates should use `replace` so the
 * marker becomes the destination.
 */
let openLayers = 0;
export function useBackToClose(onBack: () => void, on = true) {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!on) return;
    openLayers++;
    // The marker takes the next router index, so a `replace` navigation from inside the layer lands at that index.
    const st = window.history.state;
    if (!st?.cairnLayer) window.history.pushState({ ...st, idx: typeof st?.idx === 'number' ? st.idx + 1 : st?.idx, cairnLayer: 1 }, '');
    const onPop = () => { if (!window.history.state?.cairnLayer) cb.current(); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      openLayers--;
      // Deferred so a layer that opens right after this one closes (or a StrictMode remount) can adopt the marker.
      setTimeout(() => { if (openLayers === 0 && window.history.state?.cairnLayer) window.history.back(); }, 0);
    };
  }, [on]);
}

export function Modal({ children, onClose, className = 'modal', label, focusDialog }: {
  children: ReactNode; onClose: () => void; className?: string; label: string;
  /** Focus the dialog itself rather than its first field (so a phone keyboard doesn't open). */
  focusDialog?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  // Runs once per open: callers often pass an inline onClose, and re-running would steal focus on every render.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    document.addEventListener('keydown', onKey);
    // The portal mounts its children a render later, so wait for the dialog before moving focus into it.
    let raf = 0, tries = 0;
    const focusIn = () => {
      const box = ref.current;
      if (!box) { if (++tries < 10) raf = requestAnimationFrame(focusIn); return; }
      if (box.contains(document.activeElement)) return;
      const first = focusDialog ? null : (box.querySelector<HTMLElement>('[data-autofocus], [autofocus]') ?? box.querySelector<HTMLElement>('input, textarea, button'));
      (first ?? box).focus({ preventScroll: true });
    };
    focusIn();
    return () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  useBackToClose(() => close.current());
  return (
    <FloatingPortal>
      <div
        className="overlay"
        // Close on click, and only when the press also started on the backdrop: closing on press would let the tap
        // fall through to the page underneath, and a text selection dragged out of the dialog shouldn't close it.
        onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
        onClick={(e) => { if (e.target === e.currentTarget && downOnBackdrop.current) onClose(); downOnBackdrop.current = false; }}
      >
        <div ref={ref} className={className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>{children}</div>
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
