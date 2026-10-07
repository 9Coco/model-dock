import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { SecretCodec, Store } from './store';
import type { GatewayStatus } from '../shared/types';
import type { AppSettings } from '../shared/settings-types';

type Stage = 'defaults' | 'enabled' | 'disabled' | 'occupied';
interface StartupState {
  dataDir: string;
  settings: Pick<AppSettings, 'theme' | 'autoStartGateway' | 'gatewayPort' | 'launchAtLogin'>;
  gateway: GatewayStatus;
}
interface Layout {
  page: 'service' | 'settings';
  requestedSize: number[];
  theme: string;
  documentOverflow: boolean;
  mainOverflow: boolean;
  switchVisible: boolean;
  checked: boolean;
  errorVisible: boolean;
}

/** Windows safeStorage depends on Chromium's profile-specific Local State key.
 * These restart fixtures intentionally reopen only the database and vault in a
 * fresh browser profile, so use the existing portable local AES format for QA.
 * The production vault and the fresh-profile validator remain unchanged. */
export function createGatewayStartupSmokeVault(dataDir: string): SecretCodec {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(process.env.MODELDOCK_SMOKE_GATEWAY_STARTUP, '1');
  assert.equal(resolve(dataDir), resolve(process.env.MODELDOCK_DATA_DIR!));
  const keyPath = join(dataDir, 'vault.key'), info = lstatSync(keyPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === 32, 'Startup QA requires its verified fixture vault');
  const key = () => {
    const value = readFileSync(keyPath);
    assert.equal(value.length, 32);
    return value;
  };
  return {
    encrypt(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return 'local:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt(value) {
      assert.ok(value.startsWith('local:'), 'Startup restart fixtures require portable local encryption');
      const bytes = Buffer.from(value.slice(6), 'base64'), decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

/** The runner reopens persisted fixture files in a new, verified smoke profile.
 * A ready/release handshake keeps this real Electron process alive for HTTP and
 * native TCP ownership checks. It never writes an operating-system login item. */
export async function verifyGatewayStartup(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true, 'Gateway startup QA requires the independent smoke build');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child), 'Startup QA must use its fresh output/data profile');
  const stage = process.env.MODELDOCK_SMOKE_GATEWAY_STARTUP_STAGE as Stage;
  assert.ok(['defaults', 'enabled', 'disabled', 'occupied'].includes(stage), 'Unknown gateway startup stage');
  const customPort = Number(process.env.MODELDOCK_SMOKE_GATEWAY_PORT);
  assert.ok(Number.isInteger(customPort) && customPort >= 1024 && customPort <= 65535 && customPort !== 18181, 'Startup QA requires a distinct test-owned custom port');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitUntil(predicate: () => Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await predicate()) return; await pause(30); }
    writeFileSync(join(outputDir, 'gateway-startup-timeout.png'), await captureUi());
    throw new Error(`Gateway startup QA timed out: ${label}`);
  }
  const read = () => evaluate<StartupState>(`(async()=>{const [snapshot,preferences]=await Promise.all([window.modelDock.snapshot(),window.modelDock.getSettings()]);const settings=preferences.settings;return {dataDir:snapshot.dataDir,settings:{theme:settings.theme,autoStartGateway:settings.autoStartGateway,gatewayPort:settings.gatewayPort,launchAtLogin:settings.launchAtLogin},gateway:snapshot.gateway};})()`);
  const toggle = '[aria-label="随应用启动本地服务"][role="switch"]';
  const serviceToggle = `[data-action="gateway-autostart"] ${toggle}`;
  async function click(selector: string): Promise<void> {
    await waitUntil(() => evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`), selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function navigate(page: 'service' | 'settings'): Promise<void> {
    await click(`[data-page="${page}"]`);
    await waitUntil(() => evaluate<boolean>(`!!document.querySelector(${JSON.stringify(page === 'service' ? serviceToggle : toggle)})`), `${page} startup switch`);
  }
  async function automatic(page: 'service' | 'settings', checked: boolean): Promise<StartupState> {
    const before = await read();
    await navigate(page);
    const selector = page === 'service' ? serviceToggle : toggle;
    await waitUntil(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked')===${JSON.stringify(String(before.settings.autoStartGateway))}`), 'startup preference rendered before changing it');
    const displayed = await evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')==='true'`);
    assert.equal(displayed, before.settings.autoStartGateway, 'Each page must read the persisted startup setting');
    if (displayed !== checked) await click(selector);
    await waitUntil(async () => (await read()).settings.autoStartGateway === checked, 'startup preference persisted');
    const after = await read();
    assert.equal(after.gateway.running, before.gateway.running, 'The startup switch must not start or stop the current gateway');
    assert.equal(after.settings.gatewayPort, customPort, 'Changing the startup switch must preserve the chosen service port');
    assert.equal(after.settings.launchAtLogin, before.settings.launchAtLogin, 'Gateway QA must not change OS login preferences');
    await navigate(page === 'service' ? 'settings' : 'service');
    await waitUntil(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-checked')===${JSON.stringify(String(checked))}`), 'startup switch synchronized between pages');
    return after;
  }
  async function captureLayouts(checked: boolean): Promise<Layout[]> {
    const layouts: Layout[] = [];
    for (const requestedSize of [[1320, 880], [980, 680]]) {
      window.setSize(requestedSize[0], requestedSize[1]);
      for (const page of ['service', 'settings'] as const) {
        await navigate(page);
        await evaluate(`document.querySelector(${JSON.stringify(toggle)}).scrollIntoView({block:'nearest'})`);
        await pause(100);
        const layout = await evaluate<Omit<Layout, 'page' | 'requestedSize'>>(`(()=>{const control=document.querySelector(${JSON.stringify(toggle)}),main=document.querySelector('main'),box=control.getBoundingClientRect(),error=document.querySelector('.gateway-error'),errorBox=error?.getBoundingClientRect();const inside=r=>r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;return {theme:document.documentElement.dataset.theme,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:main.scrollWidth>main.clientWidth+1,switchVisible:box.width>0&&box.height>0&&inside(box),checked:control.getAttribute('aria-checked')==='true',errorVisible:!!errorBox&&inside(errorBox)};})()`);
        assert.equal(layout.theme, 'dark'); assert.equal(layout.documentOverflow, false); assert.equal(layout.mainOverflow, false);
        assert.equal(layout.switchVisible, true); assert.equal(layout.checked, checked);
        if (stage === 'occupied' && page === 'service') assert.equal(layout.errorVisible, true, 'Startup failure must remain visible on the usable service page');
        layouts.push({ page, requestedSize, ...layout });
        writeFileSync(join(outputDir, `electron-gateway-startup-${stage}-${page}-${requestedSize[0]}.png`), await captureUi());
      }
    }
    return layouts;
  }

  await waitUntil(() => evaluate<boolean>(`!!window.modelDock&&!!document.querySelector('.app-shell')`), 'usable renderer and preload bridge');
  const initial = await read();
  assert.equal(resolve(initial.dataDir), resolve(store.dataDir));
  assert.equal(initial.settings.launchAtLogin, false, 'Fresh fixtures leave actual OS startup registration alone');
  assert.equal(initial.gateway.host, '127.0.0.1');
  const transitions: StartupState[] = [];
  let layouts: Layout[] = [];
  if (stage === 'defaults') {
    assert.equal(initial.settings.autoStartGateway, false); assert.equal(initial.settings.gatewayPort, 18181);
    assert.equal(initial.gateway.running, false); assert.equal(initial.gateway.port, 18181);
    await navigate('settings');
    await click('[data-theme-choice="dark"]');
    await waitUntil(() => evaluate<boolean>(`document.documentElement.dataset.theme==='dark'`), 'dark theme from saved settings');
    await navigate('service');
    await evaluate(`(()=>{const input=document.querySelector('[aria-label="服务端口"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(customPort))});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('.port-control button');
    await waitUntil(async () => { const state = await read(); return state.gateway.running && state.gateway.port === customPort && state.settings.gatewayPort === customPort; }, 'manual start stores its actual custom port');
    transitions.push(await read());
    await waitUntil(() => evaluate<boolean>(`document.querySelector('.port-control button')?.textContent.includes('停止服务')&&!document.querySelector('.port-control button').disabled`), 'manual stop available');
    await click('.port-control button');
    await waitUntil(async () => !(await read()).gateway.running, 'manual service stop');
    transitions.push(await read());
    transitions.push(await automatic('service', true));
  } else {
    assert.equal(initial.settings.gatewayPort, customPort); assert.equal(initial.gateway.port, customPort);
    assert.equal(initial.settings.theme, 'dark');
    assert.equal(initial.settings.autoStartGateway, stage !== 'disabled');
    assert.equal(initial.gateway.running, stage === 'enabled');
    if (stage === 'occupied') assert.ok(initial.gateway.lastError, 'Occupied startup port must report a recoverable error');
    else assert.equal(initial.gateway.lastError, '');
    if (stage === 'enabled') {
      layouts = await captureLayouts(true);
      transitions.push(await automatic('service', false));
    } else if (stage === 'disabled') {
      transitions.push(await automatic('settings', true));
    } else {
      layouts = await captureLayouts(true);
    }
  }
  const ready = await read();
  assert.equal(ready.gateway.running, stage === 'enabled');
  assert.equal(ready.settings.autoStartGateway, stage !== 'enabled');
  assert.equal(ready.settings.gatewayPort, customPort);
  assert.equal(window.isDestroyed(), false);
  assert.equal(await evaluate<boolean>(`!!document.querySelector('.app-shell')&&!document.querySelector('.modal')`), true, 'Even startup errors must leave a usable app without a blocking dialog');
  const report = { version: 1, stage, pid: process.pid, appReady: true, dataDir: store.dataDir, customPort, encryptedDatabaseBackend: 'local-aes-gcm-qa', initial, transitions, ready, layouts, osStartupChanged: false };
  writeFileSync(join(outputDir, 'gateway-startup-ready.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  const releasePath = join(outputDir, 'gateway-startup-release.json'), deadline = Date.now() + 45_000;
  while (!existsSync(releasePath) && Date.now() < deadline) await pause(100);
  assert.ok(existsSync(releasePath), 'The runner must finish native HTTP checks and release this QA instance');
  const releaseFile = lstatSync(releasePath);
  assert.ok(releaseFile.isFile() && !releaseFile.isSymbolicLink() && releaseFile.nlink === 1 && releaseFile.size <= 1024);
  const release = JSON.parse(readFileSync(releasePath, 'utf8')) as { stage?: unknown; nonce?: unknown };
  assert.equal(release.stage, stage); assert.equal(release.nonce, process.env.MODELDOCK_SMOKE_NONCE);
  const final = await read();
  assert.equal(final.gateway.running, ready.gateway.running); assert.equal(final.settings.launchAtLogin, false);
  writeFileSync(join(outputDir, 'gateway-startup-validation.json'), JSON.stringify({ ...report, final, runnerReleased: true }, null, 2), { flag: 'wx' });
}
