import type { AppSettings } from '../shared/settings-types';

export function applyTheme(theme: AppSettings['theme']): void {
  const dark = theme === 'dark' || theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}
