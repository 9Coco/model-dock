import { useEffect, useRef, type ReactNode } from 'react';
import { LoaderCircle, X } from './MaterialIcon';
export type NoticeTone = 'success' | 'error' | 'info';
export type Notify = (message: string, tone?: NoticeTone) => void;

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className={`toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}
export function Modal({ title, subtitle, children, onClose, wide = false, closeOnBackdrop = true }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean; closeOnBackdrop?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const container = box.current;
    const first = container?.querySelector<HTMLElement>('input, select, textarea') ?? container?.querySelector<HTMLElement>('button');
    first?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab' || !container) return;
      const items = [...container.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')];
      const start = items[0]; const end = items[items.length - 1];
      if (event.shiftKey && document.activeElement === start) { event.preventDefault(); end?.focus(); }
      else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); start?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (closeOnBackdrop && event.target === event.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'modal-wide' : ''}`} ref={box} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-header"><div><span className="eyebrow">MODELDOCK</span><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" title="关闭" aria-label="关闭对话框" onClick={onClose}><X size={19} /></button></div>
      {children}
    </div>
  </div>;
}
export function EmptyState({ icon, title, description, action, compact = false }: { icon: ReactNode; title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function BusyIcon({ active, children }: { active: boolean; children: ReactNode }) { return active ? <LoaderCircle size={16} className="spin" /> : children; }

