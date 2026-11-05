import type { BrowserWindow } from 'electron';

/** Use the current account menu, only after the caller creates a mock account. */
async function accountLoginMenu(window: BrowserWindow, providerId: string): Promise<{ menu: string; action: string }> {
  if (process.env.MODELDOCK_SMOKE_AUTH_MOCK !== '1' || !/^[a-f0-9-]{36}$/i.test(providerId)) throw new Error('Account login smoke requires an isolated mock provider');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  async function ready(selector: string): Promise<void> {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Account login smoke timed out: ${selector}`);
  }
  await evaluate(`document.querySelector('[data-page="auth"]').click()`);
  const menu = `[data-auth-account="${providerId}"] [data-action="account-menu"]`;
  const action = `[data-auth-account-menu="${providerId}"] [data-action="account-reauth"]`;
  await ready(menu);
  await evaluate(`(()=>{const menu=document.querySelector(${JSON.stringify(menu)});if(menu.getAttribute('aria-expanded')!=='true')menu.click();})()`);
  await ready(action);
  return { menu, action };
}

export async function beginSmokeAccountLogin(window: BrowserWindow, providerId: string): Promise<void> {
  const { action } = await accountLoginMenu(window, providerId);
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(action)}).click()`);
}

/** Verify retry becomes enabled after cancellation without starting a new grant. */
export async function verifySmokeAccountLoginAvailable(window: BrowserWindow, providerId: string): Promise<void> {
  const { menu } = await accountLoginMenu(window, providerId);
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(menu)}).click()`);
}
