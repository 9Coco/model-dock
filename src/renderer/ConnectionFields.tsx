import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, LoaderCircle } from './MaterialIcon';
import type { Notify } from './components';
import './connection-fields.css';

export function CopyValue({ value, label, onCopy }: { value: string; label: string; onCopy: (value: string, message: string) => Promise<void> }) {
  return <span className="copy-value"><code title={value}>{value || '尚未配置'}</code><button type="button" className="icon-button" data-action="copy-value" title={`复制${label}`} aria-label={`复制${label}`} disabled={!value} onClick={() => void onCopy(value, `${label}已复制。`)}><Copy size={14} /></button></span>;
}

/** A saved key is fetched only by the eye button; hiding discards the plaintext. */
export function SecretField({ label = 'API Key', available, reveal, copy, notify }: { label?: string; available: boolean; reveal: () => Promise<string>; copy: () => Promise<void>; notify: Notify }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { generation.current++; setSecret(null); setLoading(false); }, [available]);
  async function toggle() {
    if (secret !== null) { generation.current++; setSecret(null); return; }
    const current = ++generation.current;
    setLoading(true);
    try { const value = await reveal(); if (generation.current === current) setSecret(value); }
    catch { if (generation.current === current) notify('无法读取密钥，请检查是否已保存。', 'error'); }
    finally { if (generation.current === current) setLoading(false); }
  }
  async function copyKey() {
    setCopying(true);
    try { await copy(); notify(`${label}已复制。`); }
    catch { notify('无法复制密钥，请检查是否已保存。', 'error'); }
    finally { setCopying(false); }
  }
  return <div className="secret-field" data-secret-field><input aria-label={label} readOnly type={secret === null ? 'password' : 'text'} value={secret ?? (available ? '************' : '')} placeholder="尚未配置" autoComplete="off" spellCheck={false} />
    <button type="button" className="icon-button" data-action="reveal-key" disabled={!available || loading} title={secret === null ? `显示${label}` : `隐藏${label}`} aria-label={secret === null ? `显示${label}` : `隐藏${label}`} aria-pressed={secret !== null} onClick={() => void toggle()}>{loading ? <LoaderCircle size={15} className="spin" /> : <Eye size={15} />}</button>
    <button type="button" className="icon-button" data-action="copy-key" disabled={!available || copying} title={`复制${label}`} aria-label={`复制${label}`} onClick={() => void copyKey()}><Copy size={15} /></button>
  </div>;
}
