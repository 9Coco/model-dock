import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH_KEY, sidebarMaximum, sidebarWidth, storedSidebarWidth } from '../shared/sidebar-layout';
import './sidebar-resize.css';

function savedWidth(): number {
  try { return storedSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)); }
  catch { return SIDEBAR_DEFAULT_WIDTH; }
}
function persistWidth(width: number): void {
  try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); }
  catch { /* Layout remains usable when local preferences cannot be saved. */ }
}
type Drag = { pointerId: number; startX: number; startWidth: number; preferred: number; handle: HTMLDivElement };

export function ResizableSidebar({ children }: { children: ReactNode }) {
  const [preferred, setPreferred] = useState(savedWidth);
  const preferredRef = useRef(preferred);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const width = sidebarWidth(preferred, viewport);
  const maximum = sidebarMaximum(viewport);
  const changeWidth = (next: number) => { preferredRef.current = next; setPreferred(next); };
  const finishDrag = useCallback((commit: boolean) => {
    const operation = drag.current;
    if (!operation) return;
    // Clear first: releasing capture emits lostpointercapture synchronously.
    drag.current = null;
    if (commit) persistWidth(preferredRef.current);
    else { preferredRef.current = operation.preferred; setPreferred(operation.preferred); }
    setDragging(false);
    document.documentElement.classList.remove('sidebar-resizing');
    try { if (operation.handle.hasPointerCapture(operation.pointerId)) operation.handle.releasePointerCapture(operation.pointerId); } catch { /* The browser can already have released it. */ }
  }, []);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    const blur = () => finishDrag(false);
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); finishDrag(false); } };
    window.addEventListener('resize', resize); window.addEventListener('blur', blur); window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', resize); window.removeEventListener('blur', blur); window.removeEventListener('keydown', escape);
      document.documentElement.classList.remove('sidebar-resizing');
      const operation = drag.current; drag.current = null;
      try { if (operation?.handle.hasPointerCapture(operation.pointerId)) operation.handle.releasePointerCapture(operation.pointerId); } catch { /* No live capture remains after unmount. */ }
    };
  }, [finishDrag]);
  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth(preferredRef.current, window.innerWidth), preferred: preferredRef.current, handle: event.currentTarget };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { drag.current = null; return; }
    setDragging(true); document.documentElement.classList.add('sidebar-resizing');
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const operation = drag.current;
    if (operation?.pointerId !== event.pointerId) return;
    changeWidth(sidebarWidth(operation.startWidth + event.clientX - operation.startX, window.innerWidth));
  };
  const keyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); finishDrag(false); return; }
    if (drag.current) return;
    const current = sidebarWidth(preferredRef.current, window.innerWidth), step = event.shiftKey ? 24 : 8;
    const next = event.key === 'ArrowLeft' ? current - step : event.key === 'ArrowRight' ? current + step : event.key === 'Home' ? SIDEBAR_MIN_WIDTH : event.key === 'End' ? sidebarMaximum(window.innerWidth) : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const bounded = sidebarWidth(next, window.innerWidth); changeWidth(bounded); persistWidth(bounded);
  };
  const style = { '--sidebar-width': `${width}px`, width } as CSSProperties;
  return <aside id="modeldock-sidebar" className="sidebar resizable-sidebar" style={style} data-sidebar-width={width}>
    {children}
    <div data-sidebar-resizer role="separator" aria-orientation="vertical" aria-label="调整侧边栏宽度" aria-controls="modeldock-sidebar" aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={`${width} 像素`} tabIndex={0}
      className={`sidebar-resizer${dragging ? ' dragging' : ''}`} title="拖动调整侧边栏宽度，双击恢复默认"
      onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(true); }} onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(false); }} onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(false); }} onKeyDown={keyResize}
      onDoubleClick={() => { changeWidth(SIDEBAR_DEFAULT_WIDTH); persistWidth(SIDEBAR_DEFAULT_WIDTH); }} />
  </aside>;
}
