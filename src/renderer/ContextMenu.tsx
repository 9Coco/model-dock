import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './context-menu.css';

export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  separator?: false;
  onSelect: () => void | Promise<void>;
}
export interface ContextMenuSeparator { id: string; separator: true }
export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;
export interface ContextMenuOpenEvent {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  clientX?: number;
  clientY?: number;
  preventDefault(): void;
  stopPropagation(): void;
}
interface Point { x: number; y: number }
interface MenuState extends Point {
  serial: number;
  label: string;
  items: readonly ContextMenuItem[];
  scrollPositions: ReadonlyMap<EventTarget, Point>;
}

/** Chromium can emit a delayed scroll notification without moving the page. */
export function contextMenuScrollChanged(previous: Point | undefined, current: Point | undefined): boolean {
  return !previous || !current || previous.x !== current.x || previous.y !== current.y;
}

function scrollPosition(target: EventTarget | null): Point | undefined {
  if (target === document || target === window) return { x: window.scrollX, y: window.scrollY };
  if (target instanceof Element) return { x: target.scrollLeft, y: target.scrollTop };
  return undefined;
}

function captureScrollPositions(target: EventTarget | null): ReadonlyMap<EventTarget, Point> {
  const positions = new Map<EventTarget, Point>();
  let element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  while (element) {
    positions.set(element, { x: element.scrollLeft, y: element.scrollTop });
    element = element.parentElement;
  }
  positions.set(document, { x: window.scrollX, y: window.scrollY });
  positions.set(window, { x: window.scrollX, y: window.scrollY });
  return positions;
}

/** A menu must fit even when opened against the bottom/right screen edge. */
export function contextMenuPosition(point: Point, menu: { width: number; height: number }, viewport: { width: number; height: number }): Point {
  const margin = 8;
  const maximumX = Math.max(margin, viewport.width - menu.width - margin);
  const maximumY = Math.max(margin, viewport.height - menu.height - margin);
  return { x: Math.min(Math.max(margin, point.x), maximumX), y: Math.min(Math.max(margin, point.y), maximumY) };
}

/** Disabled actions and separators do not become keyboard destinations. */
export function contextMenuNextIndex(items: readonly ContextMenuItem[], from: number, direction: 1 | -1): number {
  if (!items.length) return -1;
  for (let step = 1; step <= items.length; step++) {
    const index = ((from + direction * step) % items.length + items.length) % items.length;
    const item = items[index];
    if (!item.separator && !item.disabled) return index;
  }
  return -1;
}

function nativeContextTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!element) return false;
  if (element.closest('input, textarea, select')) return true;
  const editable = element.closest<HTMLElement>('[contenteditable]');
  return !!editable && editable.contentEditable !== 'false';
}

function normalized(items: readonly ContextMenuItem[]): ContextMenuItem[] {
  const result: ContextMenuItem[] = [];
  for (const item of items) {
    if (item.separator && (!result.length || result.at(-1)?.separator)) continue;
    result.push(item);
  }
  if (result.at(-1)?.separator) result.pop();
  return result;
}

function Popup({ state, close, onError }: { state: MenuState; close: () => void; onError: (error: unknown) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const activeIndex = useRef(-1);
  // Measure invisibly inside the viewport: an initially overflowing fixed box
  // can change page scroll geometry before its clamped position is committed.
  const [position, setPosition] = useState<Point>({ x: 8, y: 8 });
  const [positioned, setPositioned] = useState(false);
  const focus = useCallback((index: number) => {
    activeIndex.current = index;
    if (index < 0) { box.current?.focus({ preventScroll: true }); return; }
    const button = buttons.current.get(index);
    button?.focus({ preventScroll: true });
    const container = box.current;
    if (button && container) {
      const item = button.getBoundingClientRect(), menu = container.getBoundingClientRect();
      if (item.top < menu.top + 5) container.scrollTop -= menu.top + 5 - item.top;
      else if (item.bottom > menu.bottom - 5) container.scrollTop += item.bottom - menu.bottom + 5;
    }
  }, []);
  const activate = useCallback((item: ContextMenuAction) => {
    if (item.disabled) return;
    close();
    try { void Promise.resolve(item.onSelect()).catch(onError); }
    catch (error) { onError(error); }
  }, [close, onError]);

  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(contextMenuPosition(state, rect, { width: window.innerWidth, height: window.innerHeight }));
    setPositioned(true);
  }, [state]);
  useLayoutEffect(() => {
    if (positioned) focus(contextMenuNextIndex(state.items, -1, 1));
  }, [positioned, state.items, focus]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !box.current?.contains(event.target)) close();
    };
    const scroll = (event: Event) => {
      // Long menus can scroll internally; scrolling the page dismisses them.
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      // A pending notification from before opening must not dismiss a menu
      // whose anchor and scroll position have remained unchanged.
      if (contextMenuScrollChanged(event.target ? state.scrollPositions.get(event.target) : undefined, scrollPosition(event.target))) close();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') { close(); return; }
      const menuKeys = ['Escape', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '];
      if (!menuKeys.includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { close(); return; }
      if (event.key === 'Enter' || event.key === ' ') {
        const item = state.items[activeIndex.current];
        if (item && !item.separator) activate(item);
        return;
      }
      const next = event.key === 'Home' ? contextMenuNextIndex(state.items, -1, 1)
        : event.key === 'End' ? contextMenuNextIndex(state.items, 0, -1)
        : contextMenuNextIndex(state.items, activeIndex.current, event.key === 'ArrowUp' ? -1 : 1);
      focus(next);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [state.items, state.scrollPositions, close, focus, activate]);

  return <div ref={box} role="menu" aria-label={state.label} aria-orientation="vertical" tabIndex={-1}
    data-context-menu className="app-context-menu"
    style={{ left: position.x, top: position.y, visibility: positioned ? 'visible' : 'hidden' }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div className="app-context-menu-label" aria-hidden="true" title={state.label}>{state.label}</div>
    {state.items.map((item, index) => item.separator
      ? <div className="app-context-menu-separator" role="separator" key={`${item.id}-${index}`} />
      : <button type="button" role="menuitem" key={`${item.id}-${index}`} tabIndex={-1}
        ref={button => { if (button) buttons.current.set(index, button); else buttons.current.delete(index); }}
        data-context-menu-action={item.id} disabled={!!item.disabled} aria-disabled={!!item.disabled}
        className={`app-context-menu-item${item.danger ? ' danger' : ''}`} title={item.label}
        onPointerEnter={() => { if (!item.disabled) focus(index); }} onFocus={() => { activeIndex.current = index; }}
        onClick={() => activate(item)}>
        <span className="app-context-menu-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
      </button>)}
  </div>;
}

/** App actions stay in the renderer; opening a menu never executes an action. */
export function useContextMenu(options: { onError?: (error: unknown) => void } = {}) {
  const [state, setState] = useState<MenuState | null>(null);
  const serial = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const errorHandler = useRef(options.onError);
  errorHandler.current = options.onError;
  const onError = useCallback((error: unknown) => { errorHandler.current?.(error); }, []);
  const close = useCallback(() => {
    setState(null);
    const previous = returnFocus.current;
    returnFocus.current = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }, []);
  const open = useCallback((event: ContextMenuOpenEvent, items: readonly ContextMenuItem[], label = '操作菜单'): boolean => {
    if (nativeContextTarget(event.target) || window.getSelection()?.toString()) {
      setState(null);
      returnFocus.current = null;
      return false;
    }
    const menuItems = normalized(items);
    if (!menuItems.some(item => !item.separator)) return false;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button,a[href],[tabindex="0"]') : null;
    const source = target ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (source && source.tabIndex >= 0) returnFocus.current = source;
    else if (!active?.closest('[data-context-menu]')) returnFocus.current = active;
    const keyboard = !event.clientX && !event.clientY;
    const rect = keyboard ? source?.getBoundingClientRect() ?? active?.getBoundingClientRect() : undefined;
    const x = keyboard ? rect?.left ?? 8 : event.clientX ?? 8;
    const y = keyboard ? Math.min((rect?.bottom ?? 8) + 3, window.innerHeight - 8) : event.clientY ?? 8;
    setState({ serial: ++serial.current, x, y, label, items: menuItems, scrollPositions: captureScrollPositions(event.target ?? event.currentTarget) });
    return true;
  }, []);
  return { open, close, menu: state ? createPortal(<Popup key={state.serial} state={state} close={close} onError={onError} />, document.body) : null };
}
