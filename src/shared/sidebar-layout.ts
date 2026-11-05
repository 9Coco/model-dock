/** Renderer-only layout preference; unrelated to model or tool configuration. */
export const SIDEBAR_WIDTH_KEY = 'modeldock.sidebar-width';
export const SIDEBAR_DEFAULT_WIDTH = 216;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
const MIN_MAIN_WIDTH = 620;

export function sidebarMaximum(viewportWidth: number): number {
  const viewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1080;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(viewport - MIN_MAIN_WIDTH)));
}

export function sidebarWidth(preferred: number, viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarMaximum(viewportWidth), Math.round(Number.isFinite(preferred) ? preferred : SIDEBAR_DEFAULT_WIDTH)));
}

export function storedSidebarWidth(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return SIDEBAR_DEFAULT_WIDTH;
  const width = Number(value);
  return width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH ? width : SIDEBAR_DEFAULT_WIDTH;
}
