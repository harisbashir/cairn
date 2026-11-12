import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface DropTarget { id: string; before: boolean }

interface Options {
  /** Ids in their current order. */
  ids: string[];
  /** The element that represents an item, used for hit-testing and the drag image. */
  element: (id: string) => HTMLElement | null;
  /** Whether an item fills its row, so the drop goes above/below it rather than left/right. */
  fullRow?: (el: HTMLElement) => boolean;
  onDrop: (dragId: string, target: DropTarget) => void;
  /**
   * `handle`: the press is on a dedicated grip, so dragging starts right away for mouse and touch.
   * `press`: the press is on the item itself; a mouse starts after a few pixels, a finger after a long press so the
   * page can still scroll and taps still open the item.
   */
  mode: 'handle' | 'press';
}

const EDGE = 80;
const MAX_SPEED = 22;
const LONG_PRESS_MS = 320;

/** The nearest scrollable ancestor, which is what auto-scroll moves while dragging near its edges. */
function scrollerOf(el: HTMLElement | null): HTMLElement {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement as HTMLElement;
}

/**
 * Pointer-based reordering that works the same with a mouse, a finger or a pen. A translucent copy follows the
 * pointer, the list scrolls when the pointer nears the top or bottom edge, and Escape cancels.
 */
export function useReorder(opts: Options) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const o = useRef(opts);
  o.current = opts;
  const suppressClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const begin = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0 || cleanup.current) return;
    const pointerId = e.pointerId;
    const touch = e.pointerType === 'touch';
    const startX = e.clientX, startY = e.clientY;
    let x = startX, y = startY;
    let active = false, offX = 0, offY = 0, raf = 0, timer = 0;
    let ghost: HTMLElement | null = null;
    let target: DropTarget | null = null;
    let scroller: HTMLElement | null = null;
    let positioned = false;
    if (o.current.mode === 'handle') e.preventDefault();

    const hitTest = () => {
      let best: { id: string; d: number; r: DOMRect; el: HTMLElement } | null = null;
      for (const other of o.current.ids) {
        if (other === id) continue;
        const el = o.current.element(other);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        const d = dx * dx + dy * dy;
        if (!best || d < best.d) best = { id: other, d, r, el };
      }
      if (!best) return;
      const row = o.current.fullRow?.(best.el) ?? false;
      const before = row ? y < best.r.top + best.r.height / 2 : (y < best.r.top ? true : y > best.r.bottom ? false : x < best.r.left + best.r.width / 2);
      if (target?.id !== best.id || target.before !== before) { target = { id: best.id, before }; setDrop(target); }
    };

    const place = () => {
      const el = o.current.element(id);
      if (!el) return;
      if (!positioned) {
        // The item may have changed size when dragging started (Home collapses widgets), so line it up under the
        // pointer again before taking the drag image.
        positioned = true;
        const r0 = el.getBoundingClientRect();
        if (y < r0.top || y > r0.bottom) scroller!.scrollTop += r0.top - (y - Math.min(24, r0.height / 2));
        const r = el.getBoundingClientRect();
        offX = Math.min(Math.max(x - r.left, 0), r.width);
        offY = Math.min(Math.max(y - r.top, 0), r.height);
        ghost = el.cloneNode(true) as HTMLElement;
        ghost.removeAttribute('id');
        ghost.classList.remove('dragging');
        ghost.classList.add('reorder-ghost');
        // Clones don't carry live form values over.
        const src = el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea');
        ghost.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea').forEach((f, i) => { if (src[i]) f.value = src[i].value; });
        Object.assign(ghost.style, { position: 'fixed', left: '0', top: '0', width: `${r.width}px`, height: `${r.height}px`, margin: '0', zIndex: '200', pointerEvents: 'none' });
        document.body.appendChild(ghost);
      }
      if (ghost) ghost.style.transform = `translate(${x - offX}px, ${y - offY}px)`;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!scroller) return;
      const r = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
      // Leave room for bars that float over the bottom of the scroller (tab bar, Customize bar).
      const bottom = Math.min(r.bottom, window.innerHeight) - 56;
      let v = 0;
      if (y < r.top + EDGE) v = -MAX_SPEED * Math.min(1, (r.top + EDGE - y) / EDGE);
      else if (y > bottom - EDGE) v = MAX_SPEED * Math.min(1, (y - (bottom - EDGE)) / EDGE);
      if (v) { const before = scroller.scrollTop; scroller.scrollTop += v; if (scroller.scrollTop !== before) hitTest(); }
    };

    const activate = () => {
      active = true;
      scroller = scrollerOf(o.current.element(id));
      document.body.classList.add('reordering');
      setDragId(id);
      setDrop(null);
      if (touch) navigator.vibrate?.(8);
      raf = requestAnimationFrame(tick);
      requestAnimationFrame(() => { place(); hitTest(); });
    };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      x = ev.clientX; y = ev.clientY;
      if (!active) {
        const far = Math.hypot(x - startX, y - startY) > (touch ? 8 : 4);
        if (o.current.mode === 'handle' ? far : far && !touch) activate();
        else if (far && touch) finish(false); // a scroll, not a long press
        return;
      }
      place();
      hitTest();
    };
    // Once a finger drag is live the page mustn't scroll under it; auto-scroll does that job.
    const blockTouch = (ev: TouchEvent) => { if (active) ev.preventDefault(); };
    const up = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(ev.type === 'pointerup'); };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); finish(false); } };
    const noMenu = (ev: Event) => { if (active || timer) ev.preventDefault(); };

    function finish(commit: boolean) {
      window.clearTimeout(timer);
      timer = 0;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('touchmove', blockTouch);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('contextmenu', noMenu, true);
      ghost?.remove();
      document.body.classList.remove('reordering');
      if (active) {
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        if (commit && target) o.current.onDrop(id, target);
        setDragId(null);
        setDrop(null);
      }
      cleanup.current = null;
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('touchmove', blockTouch, { passive: false });
    window.addEventListener('keydown', key, true);
    window.addEventListener('contextmenu', noMenu, true);
    cleanup.current = () => finish(false);
    if (touch && o.current.mode === 'press') timer = window.setTimeout(() => { timer = 0; activate(); }, LONG_PRESS_MS);
  };

  return {
    dragId,
    drop,
    /** Spread on the grip (handle mode) or the item (press mode). */
    bind: (id: string) => ({ onPointerDown: (e: ReactPointerEvent) => begin(e, id) }),
    /** True right after a drag, so the click that ends it doesn't also open the item. */
    wasDrag: () => suppressClick.current,
  };
}

/** Where `dragId` lands among `ids` for a drop on `target`, as the id it should follow (null for first). */
export function afterIdFor(ids: string[], dragId: string, target: DropTarget): string | null {
  const rest = ids.filter((i) => i !== dragId);
  const at = rest.indexOf(target.id) + (target.before ? 0 : 1);
  return at <= 0 ? null : rest[at - 1];
}
