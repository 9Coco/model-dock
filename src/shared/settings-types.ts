export type ThemePreference = 'system' | 'light' | 'dark';
export type TerminalPreference = 'system' | 'powershell' | 'cmd' | 'windows-terminal' | 'x-terminal-emulator' | 'gnome-terminal' | 'konsole';

export interface AppSettings {
  theme: ThemePreference;
  launchAtLogin: boolean;
  startHidden: boolean;
  closeToTray: boolean;
  autoStartGateway: boolean;
  gatewayPort: number;
  terminal: TerminalPreference;
  /** Empty uses system proxy rules; otherwise an explicitly selected local proxy. */
  proxyUrl: string;
}

export interface TerminalOption { id: TerminalPreference; label: string }
export interface SettingsSnapshot {
  settings: AppSettings;
  platform: 'win32' | 'linux' | 'other';
  launchAtLoginSupported: boolean;
  actualLaunchAtLogin: boolean;
  launchAtLoginReason?: string;
  terminalOptions: TerminalOption[];
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  theme: 'light', launchAtLogin: false, startHidden: false, closeToTray: true, autoStartGateway: false, gatewayPort: 18181, terminal: 'system', proxyUrl: '',
});
