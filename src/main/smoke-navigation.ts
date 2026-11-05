import type { BrowserWindow } from 'electron';

/** Reveal the applicable sidebar panel before a smoke test uses its controls. */
export async function revealSmokeNavigationTarget(window: BrowserWindow, selector: string): Promise<void> {
  await window.webContents.executeJavaScript(`(()=>{const selector=${JSON.stringify(selector)},target=document.querySelector(selector),panel=target?.closest('[data-sidebar-provider-category]'),category=panel?.dataset.sidebarProviderCategory||(selector.includes('add-api-provider')?'api':null);if(category){const tab=document.querySelector('[data-provider-category="'+category+'"]');if(tab?.getAttribute('aria-selected')!=='true')tab?.click();}})()`);
}
