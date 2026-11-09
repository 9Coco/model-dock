// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserWindow, screen } from 'electron';
import type { FlowBridgeSnapshot, NetworkEngineStatus } from '../shared/flowbridge-types';
import type { Store } from './store';
import type { NetworkEngine } from './flowbridge-engine';

const cancellationAddress = 'socks5://192.0.2.31:38473';

// Exercise the real manager, IPC and controls while keeping privileged system networking out of QA.
export function createNetworkSmokeEngine(): NetworkEngine {
  let running = false;
  let samples = 0;
  let releaseConnect: (() => void) | undefined;
  return {
    async request<T>(method: string, args?: Record<string, unknown>) {
      switch (method) {
        case 'localProxies':
          return ['socks5://127.0.0.1:19321'] as T;
        case 'connect': {
          const settings = args?.settings as FlowBridgeSnapshot['settings'];
          if (settings.address === cancellationAddress) {
            await new Promise<void>(resolve => { releaseConnect = resolve; });
            releaseConnect = undefined;
          }
          running = true;
          samples = 0;
          break;
        }
        case 'cancel':
          releaseConnect?.();
          break;
        case 'disconnect':
          running = false;
          break;
        case 'snapshot':
          if (running) samples++;
          break;
        default:
          throw new Error(`Unsupported network UI fixture request: ${method}`);
      }
      const status: NetworkEngineStatus = { running, cleanupConfirmed: !running, localPort: null,
        connections: running ? 1 : 0, uploadBytes: samples * 2048, downloadBytes: samples * 8192, message: '' };
      return status as T;
    },
    async close() { releaseConnect?.(); running = false; },
  };
}

async function availableGatewayPort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  assert.ok(address && typeof address === 'object');
  return address.port;
}

export async function verifyNetworkUi(window: BrowserWindow, store: Store, output: string, capture: () => Promise<Buffer>) {
  const modelConfig = () => ({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings() });
  const before = modelConfig();
  const evaluate = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script);
  async function wait(expression: string, contents = window.webContents) {
    for (let i = 0; i < 100; i++) {
      if (await contents.executeJavaScript(expression)) return;
      await delay(50);
    }
    throw new Error(`Network UI condition failed: ${expression}`);
  }
  const query = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
  async function click(selector: string) {
    await wait(`!!${query(selector)} && !${query(selector)}.disabled`);
    await evaluate(`${query(selector)}.click()`);
  }
  async function fill(selector: string, value: string) {
    await evaluate(`(() => {const input=${query(selector)};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  }
  const network = () => evaluate<FlowBridgeSnapshot>('window.modelDock.networkSnapshot()');
  const gateway = () => evaluate<{ running: boolean; port: number; host: string }>('window.modelDock.runtimeSnapshot().then(s=>s.gateway)');
  const servicePage = '[data-service-workspace]';
  const networkPage = '[data-network-workspace]';
  const networkState = (state: string) => `!!${query(`[data-network-service-status="${state}"]`)}`;
  const gatewayButton = '[data-gateway-panel] .port-control button';
  const gatewayState = (state: string) => `!!${query(`[data-gateway-service-status="${state}"]`)}`;
  async function verifyPage(page: 'service' | 'network') {
    await wait(`!!${query(`[data-page="${page}"][aria-current="page"]`)}`);
    if (page === 'network') {
      await wait(`!!${query(networkPage + ' [data-network-panel]')} && !!${query(networkPage + ' .network-tools')}`);
      assert.equal(await evaluate(`!!${query(servicePage)}`), false);
    } else {
      await wait(`!!${query(servicePage + ' [data-gateway-panel]')}`);
      assert.equal(await evaluate(`!!${query('[data-network-panel], .network-tools, [data-service-tab="network"]')}`), false);
    }
  }
  async function openPage(page: 'service' | 'network') {
    await click(`[data-page="${page}"]`);
    await verifyPage(page);
  }

  // These records were written before the application opened the legacy fixture database.
  for (const suffix of ['a', 'b']) {
    const id = `duplicate-deepseek-${suffix}`;
    assert.ok(before.providers.some(provider => provider.id === id && provider.hasSecret));
    assert.ok(before.models.some(model => model.providerId === id && model.alias === `duplicate-${suffix}`));
  }
  assert.ok(before.bindings.length);
  await verifyPage('service');
  assert.equal(await evaluate(`${query('[data-page="network"]')}.textContent.trim()`), '网络接管');
  assert.equal(await evaluate(`${query('[data-page="network"]')}.nextElementSibling === ${query('[data-page="auth"]')}`), true);
  assert.equal(await evaluate(gatewayState('stopped')), true);
  const idle = await network();
  assert.equal(idle.state, 'idle');
  assert.equal(idle.settings.autoConnect, false);

  const port = await availableGatewayPort();
  await fill('#service-port', String(port));
  await click(gatewayButton);
  await wait(gatewayState('running'));
  assert.deepEqual(await network(), idle, 'Starting the local gateway must preserve the network session');
  await openPage('network');
  assert.equal(await evaluate(`${query('[data-action="connect-network"]')}.disabled`), true);
  if (process.platform === 'win32') {
    assert.equal(await evaluate("document.body.innerText.includes('手机热点')"), false);
    assert.equal(await evaluate(`!!${query('[data-action="save-network-address"]')}`), false);
    await click('[data-action="discover-network-proxy"]');
    await wait(`!!${query('.network-candidates button')}`);
    assert.deepEqual((await network()).settings, idle.settings, 'Discovery alone must leave settings alone');
    await click('.network-candidates button');
    await wait(`${query('#network-address')}.value==='socks5://127.0.0.1:19321' && !${query('[data-action="connect-network"]')}.disabled`);
    const applied = await network();
    assert.equal(applied.settings.mode, 'global');
    assert.equal(applied.settings.address, 'socks5://127.0.0.1:19321');
    assert.equal(applied.state, 'idle', 'Applying a candidate must not start the session');
    await openPage('service');
    await openPage('network');
    assert.equal(await evaluate(`${query('#network-address')}.value`), applied.settings.address);
    await click('[data-action="connect-network"]');
    await wait(networkState('connected'));
    await click('[data-action="disconnect-network"]');
    await wait(networkState('idle'));

    await fill('#network-address', 'invalid-address');
    await click('[data-action="connect-network"]');
    await wait("document.querySelector('.toast-stack .toast.error')?.textContent.includes('端口')");
    assert.equal((await network()).state, 'idle');
    assert.deepEqual((await network()).settings, applied.settings);
    await fill('#network-address', '127.0.0.1:19322');
    await click('[aria-label="网络连接模式"] button:first-child');
    await click('[aria-label="网络连接模式"] button:nth-child(2)');
    assert.deepEqual((await network()).settings, applied.settings, 'Editing must wait for an explicit action');
  } else {
    await fill('#network-address', '192.0.2.30:38473');
    await click('[data-action="save-network-address"]');
    await wait(`${query('#network-address')}.value==='http://192.0.2.30:38473'`);
    await click('[aria-label="网络连接模式"] button:nth-child(2)');
    await wait(`${query('#network-address')}.value==='socks5://192.0.2.30:38473'`);
  }
  assert.equal((await network()).state, 'idle');
  assert.equal(await evaluate(`${query('[data-action="connect-network"]')}.disabled`), false);
  const activeGateway = await gateway();
  assert.equal(activeGateway.running, true);
  assert.equal(activeGateway.port, port);
  assert.equal(activeGateway.host, '127.0.0.1');
  await click('[data-action="connect-network"]');
  await wait(networkState('connected'));
  const configured = await network();
  assert.equal(configured.status.running, true);
  assert.equal(configured.settings.mode, 'global');
  assert.equal(configured.settings.address, process.platform === 'win32' ? 'socks5://127.0.0.1:19322' : 'socks5://192.0.2.30:38473');
  assert.equal((await gateway()).running, true);

  await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  const layouts = [];
  const screenshots = [];
  async function verifyTrafficColors(contents = window.webContents) {
    const colors: { text: string[]; line: string }[] = await contents.executeJavaScript(`['upload', 'download'].map(direction => {
      const metrics = document.querySelectorAll('.network-metrics [data-direction="' + direction + '"] > *');
      const series = getComputedStyle(document.querySelector('polyline[data-direction="' + direction + '"]'));
      return { text: Array.from(metrics, metric => getComputedStyle(metric).color), line: series.stroke.toLowerCase() === 'currentcolor' ? series.color : series.stroke };
    })`);
    for (const { text, line } of colors) {
      assert.ok(text.length >= 2);
      for (const color of text) assert.equal(color, line, 'Traffic labels, values and curve must have the same color');
    }
    assert.notEqual(colors[0].line, colors[1].line, 'Upload and download must have different colors');
  }
  window.setMinimumSize(780, 580);
  for (const [theme, width, height, filename] of [
    ['light', 1320, 880, 'network-light.png'], ['dark', 1320, 880, 'network-dark.png'],
    ['dark', 980, 680, 'network-compact.png'], ['dark', 780, 620, 'network-narrow.png'],
  ] as const) {
    await click('[data-page="settings"]');
    await wait(`!!${query('[aria-label="随 ModelDock 自动连接网络"]')}`);
    await click(`[data-theme-choice="${theme}"]`);
    await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    await openPage('network');
    window.setContentSize(width, height);
    await wait(`innerWidth===${width} && ${networkState('connected')}`);
    await wait(`!!${query('[aria-label="检测网站"]')} && !!${query('[aria-label="流量时间范围"]')}`);
    const layout = await evaluate<{ overflow: boolean; menuVisible: boolean }>(`(() => {
      const main=document.querySelector('main'), menu=${query('[data-page="network"]')}.getBoundingClientRect();
      return {overflow: document.documentElement.scrollWidth>innerWidth+1 || main.scrollWidth>main.clientWidth+1,
        menuVisible: menu.width>0 && menu.height>0 && menu.left>=0 && menu.right<=innerWidth+1 && menu.top>=0 && menu.bottom<=innerHeight+1};
    })()`);
    assert.equal(layout.overflow, false, `Network page overflow at ${width}px`);
    assert.ok(layout.menuVisible, `Network menu must remain reachable at ${width}px`);
    await verifyTrafficColors();
    await wait("document.querySelector('.network-metrics [data-direction=upload] strong').textContent !== '0 B/s'");
    layouts.push({ theme, width, ...layout });
    writeFileSync(join(output, filename), await capture());
    screenshots.push(filename);
  }
  await click('[aria-label="ModelDock 首页"]');
  await verifyPage('service');
  for (const tab of ['logs', 'interface']) {
    await click(`[data-service-tab="${tab}"]`);
    await wait(`!!${query(`[data-service-tab="${tab}"][aria-selected="true"]`)}`);
    await verifyPage('service');
  }
  await click(gatewayButton);
  await wait(gatewayState('stopped'));
  assert.equal((await network()).state, 'connected', 'Stopping the gateway must leave a connected network alone');
  await click(gatewayButton);
  await wait(gatewayState('running'));
  assert.equal((await network()).state, 'connected', 'Starting the gateway must leave a connected network alone');
  await openPage('network');
  await wait(networkState('connected'));
  await click('[data-action="disconnect-network"]');
  await wait(networkState('idle'));
  assert.deepEqual((await network()).settings, configured.settings);
  assert.equal((await gateway()).running, true);

  await fill('#network-address', cancellationAddress);
  if (process.platform !== 'win32') await click('[data-action="save-network-address"]');
  await click('[data-action="connect-network"]');
  await wait(networkState('connecting'));
  await openPage('service');
  assert.equal((await network()).state, 'connecting');
  await openPage('network');
  await wait(networkState('connecting'));
  await click('[data-action="disconnect-network"]');
  await wait(networkState('idle'));
  assert.equal((await network()).status.cleanupConfirmed, true);
  await openPage('service');
  await wait(gatewayState('running'));
  await click(gatewayButton);
  await wait(gatewayState('stopped'));
  await openPage('network');
  await click('[data-action="show-network-mini"]');
  let mini: BrowserWindow | undefined;
  for (let attempt = 0; attempt < 100 && !mini; attempt++) {
    mini = BrowserWindow.getAllWindows().find(item => item !== window && item.isVisible() && item.webContents.getURL().endsWith('#network-mini'));
    if (!mini) await delay(50);
  }
  assert.ok(mini);
  assert.equal(await mini.webContents.executeJavaScript('typeof window.modelDock'), 'undefined');
  assert.equal(await mini.webContents.executeJavaScript('typeof window.networkMonitor.snapshot'), 'function');
  await wait(`!!document.querySelector('[aria-label="展开曲线"]')`, mini.webContents);
  const miniLayout = `(() => {
    const controls = Array.from(document.querySelectorAll('.network-mini header button,.network-mini .network-metrics strong'));
    return controls.length === 5 && controls.every(control => {
      const rect = control.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth + 1
        && rect.top >= 0 && rect.bottom <= innerHeight + 1;
    });
  })()`;
  assert.equal(await mini.webContents.executeJavaScript(miniLayout), true, 'Collapsed mini monitor must show both rates and all buttons');
  const area = screen.getDisplayMatching(mini.getBounds()).workArea;
  if (process.platform === 'win32') {
    const { width, height } = mini.getBounds();
    mini.setPosition(area.x + area.width - width, area.y + area.height - height);
  }
  await mini.webContents.executeJavaScript(`document.querySelector('[aria-label="展开曲线"]').click()`);
  let miniCapture;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await mini.webContents.executeJavaScript("!!document.querySelector('.network-mini .network-chart')")) {
      const frame = await mini.webContents.capturePage();
      const pixels = frame.toBitmap();
      // The first compositor frame can still contain only the window background.
      if (pixels.some((byte, i) => byte !== pixels[i % 4])) { miniCapture = frame; break; }
    }
    await delay(100);
  }
  assert.ok(miniCapture, 'Expanded mini monitor must show a painted frame');
  await verifyTrafficColors(mini.webContents);
  if (process.platform === 'win32') {
    const { x, y, width, height } = mini.getBounds();
    assert.ok(x >= area.x && y >= area.y && x + width <= area.x + area.width + 1 && y + height <= area.y + area.height + 1,
      'Expanding the mini monitor at the screen edge must keep its controls inside the work area');
  }
  assert.equal(await mini.webContents.executeJavaScript(miniLayout), true, 'Expanded mini monitor must show both rates and all buttons');
  writeFileSync(join(output, 'network-mini.png'), miniCapture.toPNG());
  screenshots.push('network-mini.png');
  await mini.webContents.executeJavaScript("window.networkMonitor.action('hide')");
  assert.deepEqual(modelConfig(), before);
  assert.equal(store.getManagedState('network.flowbridge.lease', false), false);
  writeFileSync(join(output, 'network-validation.json'), JSON.stringify({ ok: true, defaultServiceWorkspace: true,
    sidebarNetworkBeforeAuth: true, dedicatedNetworkPage: true, sessionPreservedAcrossNavigation: true,
    modeSwitchSaved: true, gatewayControlsIndependent: true, simulatedNetworkConnectDisconnectAndCancel: true,
    osNetworkUntouched: true, existingDataPreserved: true,
    miniPreloadIsolated: true, layouts, screenshots }, null, 2));
  if (process.env.MODELDOCK_SMOKE_NETWORK_HOLD === '1') { window.show(); await delay(60_000); }
}
