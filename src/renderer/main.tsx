import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './compact-theme.css';
import './auth-compact.css';
import './material-icons.css';
import { applyTheme } from './theme';
import type { SettingsSnapshot } from '../shared/settings-types';

async function start() {
  let settings: SettingsSnapshot | undefined;
  try { settings = await window.modelDock?.getSettings?.(); } catch { /* Settings page can retry; the rest of the app remains usable. */ }
  applyTheme(settings?.settings.theme ?? 'light');
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App initialSettings={settings} /></React.StrictMode>);
}
void start();
