export type ThemePreference = 'system' | 'light' | 'dark';

export interface AppSettings {
  theme: ThemePreference;
  launchAtLogin: boolean;
  startHidden: boolean;
  closeToTray: boolean;
  autoStartGateway: boolean;
  gatewayPort: number;
  /** Empty uses system proxy rules; otherwise an explicitly selected local proxy. */
  proxyUrl: string;
}

export interface SettingsSnapshot {
  settings: AppSettings;
  platform: 'win32' | 'linux' | 'other';
  launchAtLoginSupported: boolean;
  actualLaunchAtLogin: boolean;
  launchAtLoginReason?: string;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  theme: 'light', launchAtLogin: false, startHidden: false, closeToTray: true, autoStartGateway: false, gatewayPort: 18181, proxyUrl: '',
});
