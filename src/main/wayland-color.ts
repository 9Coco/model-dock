const WAYLAND_COLOR_FEATURE = 'WaylandWpColorManagerV1';

export interface WaylandColorCommandLine {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value?: string): void;
  hasSwitch?(name: string): boolean;
}

function containsFeature(value: string, feature: string): boolean {
  // Chromium allows Feature<Trial.Group:param/value and *Feature entries.
  // Inspect the name without rewriting existing trials or their parameters.
  return value.split(',').some(entry => entry.trim().replace(/^\*/, '').split(/[<:]/, 1)[0].trim() === feature);
}

/**
 * Apply before app readiness. On this Linux/Wayland host, Chromium 152's native
 * color protocol changed correct renderer pixels into a washed-out window;
 * disabling only this feature restored an exact native/renderer pixel match.
 * Keep GPU rendering and the compositor's configuration untouched.
 *
 * Chromium's two-argument BASE_FEATURE strips the C++ identifier's initial k:
 * https://github.com/chromium/chromium/blob/152.0.7977.130/base/feature_internal.h
 */
export function applyWaylandColorWorkaround(
  commandLine: WaylandColorCommandLine,
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (platform !== 'linux') return false;
  if (commandLine.hasSwitch?.('headless') || commandLine.getSwitchValue('headless')) return false;

  const ozonePlatform = commandLine.getSwitchValue('ozone-platform').trim().toLowerCase();
  if (ozonePlatform && ozonePlatform !== 'wayland' && ozonePlatform !== 'auto') return false;
  const expectedWayland = ozonePlatform === 'wayland' || env.XDG_SESSION_TYPE?.trim().toLowerCase() === 'wayland' || !!env.WAYLAND_DISPLAY?.trim();
  if (!expectedWayland) return false;

  const disabled = commandLine.getSwitchValue('disable-features');
  if (containsFeature(disabled, WAYLAND_COLOR_FEATURE)) return false;
  // An explicit opt-in represents a user override of this compatibility fix.
  if (containsFeature(commandLine.getSwitchValue('enable-features'), WAYLAND_COLOR_FEATURE)) return false;

  const separator = disabled && !disabled.endsWith(',') ? ',' : '';
  commandLine.appendSwitch('disable-features', `${disabled}${separator}${WAYLAND_COLOR_FEATURE}`);
  return true;
}
