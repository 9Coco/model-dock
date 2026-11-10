// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserWindow, screen, session } from 'electron';
import type { FlowBridgeSnapshot, NetworkEngineStatus } from '../shared/flowbridge-types';
import { NETWORK_PROBE_URLS, NETWORK_SITES } from '../shared/flowbridge-types';
import type { Store } from './store';
import type { NetworkEngine } from './flowbridge-engine';
import { measureSiteLatency } from './proxy-speed-test';

const cancellationAddress = 'socks5://192.0.2.31:38473';
const unavailableAddress = 'socks5://192.0.2.32:38473';
const recoveryAddress = 'socks5://192.0.2.33:38473';
const delayedCleanupAddress = 'socks5://192.0.2.36:38473';

async function verifyAnonymousRedirectProbe() {
  const requests: { method: string | undefined; path: string | undefined; authenticated: boolean }[] = [];
  const origin = createHttpServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authenticated: !!request.headers.authorization || !!request.headers.cookie });
    response.writeHead(request.url === '/start' ? 301 : 405, request.url === '/start' ? { location: '/service' } : {});
    response.end();
  });
  await new Promise<void>((resolve, reject) => origin.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = origin.address();
  assert.ok(address && typeof address === 'object');
  const probe = session.fromPartition('network-probe-redirect-smoke-' + address.port);
  try {
    await probe.setProxy({ mode: 'direct' });
    const result = await measureSiteLatency('JetBrains AI', (url, init) => {
      assert.equal(url, NETWORK_PROBE_URLS['JetBrains AI']);
      return probe.fetch(`http://127.0.0.1:${address.port}/start`, init);
    });
    assert.equal(result.state, 'response', 'Electron must follow the HEAD redirect instead of rejecting a reachable origin');
    assert.ok(result.state === 'response' && result.httpStatus === 405);
    assert.deepEqual(requests, [
      { method: 'HEAD', path: '/start', authenticated: false },
      { method: 'HEAD', path: '/service', authenticated: false },
    ]);
  } finally {
    await probe.closeAllConnections();
    origin.closeAllConnections();
    await new Promise<void>(resolve => origin.close(() => resolve()));
  }
}

// Exercise the real manager, IPC and controls while keeping privileged system networking out of QA.
export function createNetworkSmokeEngine(): NetworkEngine {
  let running = false;
  let samples = 0;
  let failNextDisconnect = false;
  let delayNextDisconnect = false;
  let releaseConnect: (() => void) | undefined;
  return {
    async request<T>(method: string, args?: Record<string, unknown>) {
      switch (method) {
        case 'localProxies':
          return ['socks5://127.0.0.1:19321'] as T;
        case 'connect': {
          const settings = args?.settings as FlowBridgeSnapshot['settings'];
          if (settings.address === unavailableAddress) throw new Error('上游代理连接超时');
          failNextDisconnect = settings.address === recoveryAddress;
          delayNextDisconnect = settings.address === delayedCleanupAddress;
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
          if (delayNextDisconnect) {
            delayNextDisconnect = false;
            await delay(2500); // Allow the renderer to observe cleanup of the previous upstream.
          }
          if (failNextDisconnect) {
            failNextDisconnect = false;
            throw new Error('模拟恢复未完成');
          }
          running = false;
          break;
        case 'snapshot':
          if (running) samples++;
          break;
        default:
          throw new Error(`Unsupported network UI fixture request: ${method}`);
      }
      const status: NetworkEngineStatus = { running, cleanupConfirmed: !running, localPort: running ? 19327 : null,
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
  await verifyAnonymousRedirectProbe();
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
  const connectButton = '[data-action="connect-network"]';
  const disconnectButton = '[data-action="disconnect-network"]';
  const discoverButton = '[data-action="discover-network-proxy"]';
  async function verifySessionAction(selector: string, label: RegExp) {
    await wait(`!!${query(selector)} && ${label}.test(${query(selector)}.textContent)`);
    assert.equal(await evaluate(`document.querySelectorAll('${connectButton}, ${disconnectButton}').length`), 1);
  }
  async function verifyNoSaveButton() {
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-network-panel] button'))
      .some(button => /^(保存|应用|应用并重连)$/.test(button.textContent.trim()))`), false);
  }
  async function verifyProxySpeed() {
    await wait(`Array.from(document.querySelectorAll('[aria-label="网络连接模式"] button')).every(button=>!button.disabled)`);
    await click('[data-action="measure-proxy-speed"]');
    for (const [index, site] of NETWORK_SITES.entries()) {
      const tile = '[data-site="' + site + '"]';
      const expected = site === 'X' ? '超时' : (42 + index) + ' ms';
      await wait(`${query(tile + ' .site-latency')}.textContent === ${JSON.stringify(expected)}`);
    }
    assert.equal(await evaluate(`${query('[data-site="ChatGPT"] .site-http-status')}.textContent`), 'HTTP 403');
    assert.equal(await evaluate(`document.querySelectorAll('.site-tile').length`), 12);
    assert.equal(await evaluate(`!!document.querySelector('.transfer-rates, [data-speed-result]')`), false);
    assert.equal(await evaluate(`typeof window.modelDock.measureNetworkSpeed`), 'undefined');
    await click('[data-site="JetBrains AI"]');
    await wait(`${query('[data-network-probe-url]')}.textContent === 'https://api.jetbrains.ai/'`);
    assert.match(await evaluate<string>(`${query('[data-latency-detail]')}.textContent`), /已收到服务响应.*HTTP 200/);
    await click('[data-site="JetBrains AI"]');
  }
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
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-network-panel], .network-tools, [data-service-tab="network"]')).some(element => element.checkVisibility())`), false);
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
  await verifyPage('network');
  assert.equal(await evaluate(`${query('[data-page="network"]')}.textContent.trim()`), '网络接管');
  assert.equal(await evaluate(`${query('[data-page="network"]')}.nextElementSibling === ${query('[data-page="auth"]')}`), true);
  await openPage('service');
  assert.equal(await evaluate(gatewayState('stopped')), true);
  const idle = await network();
  const windowsNetwork = idle.platform === 'win32';
  assert.equal(idle.state, 'idle');
  assert.equal(idle.settings.autoConnect, false);

  const port = await availableGatewayPort();
  await fill('#service-port', String(port));
  await click(gatewayButton);
  await wait(gatewayState('running'));
  assert.deepEqual(await network(), idle, 'Starting the local gateway must preserve the network session');
  await openPage('network');
  await verifyNoSaveButton();
  await verifySessionAction(connectButton, /连接/);
  assert.equal(await evaluate(`${query(connectButton)}.disabled`), true);
  if (windowsNetwork) {
    assert.equal(await evaluate("document.body.innerText.includes('手机热点')"), false);
    await click(discoverButton);
    await wait(`!!${query('.network-candidates button')}`);
    assert.deepEqual((await network()).settings, idle.settings, 'Discovery alone must leave settings alone');
    await click('.network-candidates button');
    await wait(`${query('#network-address')}.value==='socks5://127.0.0.1:19321' && !${query('[data-action="connect-network"]')}.disabled`);
    const applied = await network();
    assert.equal(applied.settings.mode, 'global');
    assert.equal(applied.settings.address, 'socks5://127.0.0.1:19321');
    assert.equal(applied.state, 'idle', 'Applying a candidate must not start the session');
    await verifyProxySpeed();
    assert.deepEqual((await network()).settings, applied.settings);
    assert.equal((await network()).state, 'idle', 'Measuring the upstream must not take over the system network');
    writeFileSync(join(output, 'network-proxy-speed.png'), await capture());
    await click('[data-site="X"]');
    await wait(`!!${query('[data-site-details="X"]')}`);
    await openPage('service');
    await openPage('network');
    assert.equal(await evaluate(`${query('#network-address')}.value`), applied.settings.address);
    await click('[data-action="connect-network"]');
    await wait(networkState('connected'));
    await click('[data-action="disconnect-network"]');
    await wait(networkState('idle'));
  } else {
    await click(discoverButton);
    await wait(`!!${query('.network-candidates')}`);
    assert.deepEqual((await network()).settings, idle.settings, 'Looking up a hotspot must preserve settings');
    if (await evaluate(`!!${query('.network-candidates button')}`)) {
      await click('.network-candidates button');
      await wait(`${query('#network-address')}.value.endsWith(':38473')`);
      assert.equal((await network()).state, 'idle', 'Selecting a hotspot must not connect automatically');
    }
  }
  const speedDraft = '192.0.2.35:38473';
  await fill('#network-address', '192.0.2.35:038473/');
  await verifyProxySpeed();
  await wait(`${query('.proxy-speed-panel .network-hint')}.textContent.includes('${speedDraft}')`);
  assert.equal((await network()).state, 'idle', 'Testing a typed upstream must not take over the system network');
  const saved = (await network()).settings;
  assert.ok(saved.address.endsWith('://' + speedDraft), 'Offline measurement must use the normalized draft');
  await click('[data-site="X"]');
  await evaluate(`(() => { const select=document.querySelector('[aria-label="流量时间范围"]');select.value='15';select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const speedState = `(() => ({sites: Array.from(document.querySelectorAll('.site-tile')).map(tile => ({
    site: tile.getAttribute('data-site'), text: tile.querySelector('.site-latency').textContent,
    status: tile.querySelector('.site-http-status')?.textContent,
  })), details: document.querySelector('[data-site-details]')?.getAttribute('data-site-details'),
    range: document.querySelector('[aria-label="流量时间范围"]').value}))()`;
  const measured = await evaluate(speedState);
  for (const destination of ['[data-page="service"]', '[data-tool-id="codex"]']) {
    await click(destination);
    await wait(`!${query('.network-page')}.checkVisibility()`);
    await openPage('network');
    assert.deepEqual(await evaluate(speedState), measured, 'Completed latency results, details and range survive navigation');
  }
  await click('[data-site="X"]');
  await click('[data-action="measure-proxy-speed"]');
  await wait(`${query('[data-action="measure-proxy-speed"]')}.disabled`);
  await click('[data-tool-id="codex"]');
  await wait(`!${query('.network-page')}.checkVisibility()`);
  await wait(`${query('[data-site="Google"] .site-latency')}.textContent==='42 ms' && !${query('[data-action="measure-proxy-speed"]')}.disabled`);
  await openPage('network');
  for (const [index, site] of NETWORK_SITES.entries()) {
    assert.equal(await evaluate(`${query('[data-site="' + site + '"] .site-latency')}.textContent`), site === 'X' ? '超时' : (42 + index) + ' ms');
  }
  const modeIndex = await evaluate<number>(`Array.from(document.querySelectorAll('[aria-label="网络连接模式"] button')).findIndex(button=>button.getAttribute('aria-pressed')==='true')`);
  assert.ok(modeIndex === 0 || modeIndex === 1);
  await click(`[aria-label="网络连接模式"] button:nth-child(${2 - modeIndex})`);
  await wait(`Array.from(document.querySelectorAll('.site-latency')).every(element=>element.textContent==='—') && !document.querySelector('[data-site-details]')`);
  await click(`[aria-label="网络连接模式"] button:nth-child(${modeIndex + 1})`);
  await wait(`window.modelDock.networkSnapshot().then(snapshot => snapshot.settings.mode===${JSON.stringify(modeIndex === 0 ? "http" : "global")})`);
  await verifyProxySpeed();
  await fill('#network-address', 'invalid-address');
  await wait(`Array.from(document.querySelectorAll('.site-latency')).every(element=>element.textContent==='—')`);
  await verifyNoSaveButton();
  await click(connectButton);
  await wait("Array.from(document.querySelectorAll('.toast-stack .toast.error')).some(toast=>toast.textContent.includes('端口'))");
  assert.equal(await evaluate(`${query('#network-address')}.value`), 'invalid-address');
  assert.deepEqual((await network()).settings, saved, 'Invalid input must leave saved settings intact');

  const draft = windowsNetwork ? '127.0.0.1:19322' : '192.0.2.30:38473';
  await fill('#network-address', draft);
  await click('[aria-label="网络连接模式"] button:first-child');
  await click('[aria-label="网络连接模式"] button:nth-child(2)');
  assert.deepEqual((await network()).settings, saved, 'Editing a draft must wait for an explicit connection');
  assert.equal((await network()).state, 'idle');
  assert.equal(await evaluate(`${query('[data-action="connect-network"]')}.disabled`), false);
  const activeGateway = await gateway();
  assert.equal(activeGateway.running, true);
  assert.equal(activeGateway.port, port);
  assert.equal(activeGateway.host, '127.0.0.1');
  await click('[data-action="connect-network"]');
  await wait(networkState('connected'));
  const firstConnection = await network();
  assert.equal(firstConnection.status.running, true);
  assert.equal(firstConnection.settings.mode, 'global');
  assert.equal(firstConnection.settings.address, 'socks5://' + draft);
  await verifySessionAction(disconnectButton, /断开/);
  if (windowsNetwork) assert.equal(await evaluate(`${query(discoverButton)}.disabled`), true);
  await fill('#network-address', '192.0.2.34:38473');
  await wait(`!!${query(connectButton)} && /重连|重新连接/.test(${query(connectButton)}.textContent)`);
  assert.equal(await evaluate(`${query(disconnectButton)}.disabled`), false, 'Editing an active session must still allow disconnection');
  await verifyNoSaveButton();
  assert.deepEqual((await network()).settings, firstConnection.settings);
  await click(connectButton);
  await verifySessionAction(disconnectButton, /断开/);
  const configured = await network();
  assert.equal(configured.settings.address, 'socks5://192.0.2.34:38473');
  assert.equal(configured.state, 'connected');
  assert.equal((await gateway()).running, true);

  await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  const layouts = [];
  const screenshots = [];
  async function verifyTrafficColors(theme: 'light' | 'dark', contents = window.webContents) {
    const colors: { text: string[]; line: string }[] = await contents.executeJavaScript(`['upload', 'download'].map(direction => {
      const selector = '[data-direction="' + direction + '"]';
      const metrics = document.querySelectorAll('.network-metrics ' + selector + ' > *');
      const series = getComputedStyle(document.querySelector('polyline[data-direction="' + direction + '"]'));
      return { text: Array.from(metrics, metric => getComputedStyle(metric).color), line: series.stroke.toLowerCase() === 'currentcolor' ? series.color : series.stroke };
    })`);
    for (const { text, line } of colors) {
      assert.ok(text.length >= 2);
      for (const color of text) assert.equal(color, line, 'Traffic labels, values and curve must have the same color');
    }
    const expected = theme === 'dark' ? ['rgb(245, 203, 92)', 'rgb(85, 180, 255)'] : ['rgb(133, 100, 0)', 'rgb(34, 121, 187)'];
    assert.deepEqual(colors.map(({ line }) => line), expected, 'Upload must be yellow and download blue');
  }
  const rangeSelect = '[aria-label="流量时间范围"]';
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('${rangeSelect} option'), option => option.textContent)`), ['最近1分钟', '最近5分钟', '最近15分钟', '最近1小时']);
  for (const minutes of [1, 5, 15, 60]) {
    await evaluate(`(() => { const select = ${query(rangeSelect)}; select.value = '${minutes}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(`${query(rangeSelect)}.value === '${minutes}'`);
    assert.equal(await evaluate(`document.querySelectorAll('.traffic-history time').length`), 4);
  }
  await evaluate(`(() => { const select = ${query(rangeSelect)}; select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  window.setMinimumSize(780, 580);
  for (const [theme, width, height, filename] of [
    ['light', 1320, 880, 'network-light.png'], ['dark', 1320, 880, 'network-dark.png'],
    ['dark', 1070, 740, 'network-controls.png'], ['dark', 980, 680, 'network-compact.png'], ['dark', 780, 620, 'network-narrow.png'],
  ] as const) {
    await click('[data-page="settings"]');
    await wait(`!!${query('[aria-label="随 ModelDock 自动连接网络"]')}`);
    await click(`[data-theme-choice="${theme}"]`);
    await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    await openPage('network');
    window.setContentSize(width, height);
    await wait(`innerWidth===${width} && ${networkState('connected')}`);
    await wait(`!!${query('[aria-label="网站延迟"]')} && !!${query('[aria-label="流量时间范围"]')}`);
    await verifyProxySpeed();
    const geometry = await evaluate<{ responsiveGrid: boolean; firstRow: boolean; iconsAbove: boolean; fullWidthTraffic: boolean; phoneFullWidth: boolean | null }>(`(() => {
      const tiles = [...document.querySelectorAll('.site-tile')];
      const panel = document.querySelector('.proxy-speed-panel'), grid = document.querySelector('.network-tools');
      const columns = getComputedStyle(document.querySelector('.site-tiles')).gridTemplateColumns.split(' ').length;
      const panelBox = panel.getBoundingClientRect();
      const controls = grid.querySelector('[data-network-panel]').getBoundingClientRect();
      const traffic = grid.querySelector('.traffic-panel').getBoundingClientRect();
      const phone = grid.querySelector('.phone-proxy-panel');
      return {
        responsiveGrid: tiles.length === 12 && [3, 4, 6].includes(columns) && tiles.every((tile, index) => tile.offsetTop === tiles[Math.floor(index / columns) * columns].offsetTop),
        firstRow: grid.clientWidth >= 720 ? Math.abs(controls.top - panelBox.top) < 1 && controls.right <= panelBox.left : panelBox.top >= controls.bottom,
        iconsAbove: tiles.every(tile => tile.querySelector('.site-mark').getBoundingClientRect().bottom < tile.querySelector('.site-latency').getBoundingClientRect().top && (getComputedStyle(tile.querySelector('.site-mark')).maskImage !== 'none' || getComputedStyle(tile.querySelector('.site-mark')).backgroundImage !== 'none' || !!tile.querySelector('.site-mark img')?.complete)),
        fullWidthTraffic: traffic.top >= Math.max(controls.bottom, panelBox.bottom) && Math.abs(traffic.width - grid.clientWidth) <= 1,
        phoneFullWidth: phone ? Math.abs(phone.getBoundingClientRect().width - grid.clientWidth) <= 1 : null
      };
    })()`);
    assert.ok(geometry.responsiveGrid && geometry.firstRow && geometry.iconsAbove, 'Twelve compact latency tiles sit beside controls on desktop and stack responsively');
    assert.ok(geometry.fullWidthTraffic, 'Traffic spans the complete second row');
    assert.equal(geometry.phoneFullWidth, windowsNetwork ? null : true, 'Phone setup must span the workspace where available');
    const layout = await evaluate<{ overflow: boolean; menuVisible: boolean }>(`(() => {
      const main=document.querySelector('main'), menu=${query('[data-page="network"]')}.getBoundingClientRect();
      return {overflow: document.documentElement.scrollWidth>innerWidth+1 || main.scrollWidth>main.clientWidth+1,
        menuVisible: menu.width>0 && menu.height>0 && menu.left>=0 && menu.right<=innerWidth+1 && menu.top>=0 && menu.bottom<=innerHeight+1};
    })()`);
    assert.equal(layout.overflow, false, `Network page overflow at ${width}px`);
    assert.ok(layout.menuVisible, `Network menu must remain reachable at ${width}px`);
    const controlLayout = await evaluate<boolean>(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const card = rect('[data-network-panel]'), input = rect('#network-address'), lookup = rect('${discoverButton}');
      const primary = rect('${disconnectButton}'), mini = rect('[data-action="show-network-mini"]');
      const inside = box => box.width > 0 && box.height > 0 && box.left >= card.left && box.right <= card.right + 1;
      return [input, lookup, primary, mini].every(inside) &&
        Math.abs(lookup.top - input.top) < 60 && lookup.bottom <= primary.top + 1 &&
        (mini.left >= primary.right || mini.bottom <= primary.top || mini.top >= primary.bottom || mini.right <= primary.left);
    })()`);
    assert.ok(controlLayout, `Address lookup and connection/monitor actions must remain distinct and fit at ${width}px`);
    await verifyTrafficColors(theme);
    await wait("document.querySelector('.network-metrics [data-direction=upload] strong').textContent !== '0 B/s'");
    layouts.push({ theme, width, ...layout });
    writeFileSync(join(output, filename), await capture());
    screenshots.push(filename);
  }
  await click('[data-page="service"]');
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
  await click('[data-action="connect-network"]');
  await wait(networkState('connecting'));
  await verifySessionAction(disconnectButton, /取消/);
  await openPage('service');
  assert.equal((await network()).state, 'connecting');
  await openPage('network');
  await wait(networkState('connecting'));
  await click('[data-action="disconnect-network"]');
  await wait(networkState('idle'));
  assert.equal((await network()).status.cleanupConfirmed, true);
  await fill('#network-address', unavailableAddress);
  await click(connectButton);
  await wait(networkState('error'));
  assert.equal((await network()).status.cleanupConfirmed, true);
  await verifySessionAction(connectButton, /连接|重试/);
  await fill('#network-address', recoveryAddress);
  await click(connectButton);
  await wait(networkState('connected'));
  await click(disconnectButton);
  await wait(networkState('error'));
  assert.equal((await network()).status.cleanupConfirmed, false);
  await verifySessionAction(disconnectButton, /恢复/);
  for (const selector of ['#network-address', discoverButton, '[data-action="measure-proxy-speed"]']) {
    assert.equal(await evaluate(`${query(selector)}.disabled`), true, 'Recovery must finish before changing or testing an upstream');
  }
  assert.equal(store.getManagedState('network.flowbridge.lease', false), true);
  await click(disconnectButton);
  await wait(networkState('idle'));
  assert.equal((await network()).status.cleanupConfirmed, true);
  await fill('#network-address', delayedCleanupAddress);
  await click(connectButton);
  await wait(networkState('connected'));
  await fill('#network-address', cancellationAddress);
  await click(connectButton);
  await wait(networkState('disconnecting'));
  await verifySessionAction(disconnectButton, /取消/);
  await click(disconnectButton);
  await wait(networkState('idle'));
  assert.equal((await network()).status.cleanupConfirmed, true, 'Cancelling a reconnect during cleanup must leave the network idle');
  await openPage('service');
  await wait(gatewayState('running'));
  await click(gatewayButton);
  await wait(gatewayState('stopped'));
  await openPage('network');
  await fill('#network-address', configured.settings.address);
  await click(connectButton);
  await wait(networkState('connected'));
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
  await wait("document.querySelector('.network-mini [data-direction=upload] strong').textContent !== '0 B/s'", mini.webContents);
  await mini.webContents.executeJavaScript(`document.querySelector('[aria-label="锁定小窗"]').click()`);
  await wait(`!!document.querySelector('[aria-label="解锁小窗"]')`, mini.webContents);
  assert.equal(await mini.webContents.executeJavaScript('window.networkMonitor.snapshot().then(s => s.locked)'), true);
  const miniDragRegion = "getComputedStyle(document.querySelector('.network-mini header')).getPropertyValue('-webkit-app-region')";
  assert.equal(await mini.webContents.executeJavaScript(miniDragRegion), 'no-drag', 'A locked monitor must disable its draggable header');
  await mini.webContents.executeJavaScript(`document.querySelector('[aria-label="解锁小窗"]').click()`);
  await wait(`!!document.querySelector('[aria-label="锁定小窗"]')`, mini.webContents);
  assert.equal(await mini.webContents.executeJavaScript(miniDragRegion), 'drag', 'Unlocking must restore the draggable header');
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
  await verifyTrafficColors('dark', mini.webContents);
  if (process.platform === 'win32') {
    const { x, y, width, height } = mini.getBounds();
    assert.ok(x >= area.x && y >= area.y && x + width <= area.x + area.width + 1 && y + height <= area.y + area.height + 1,
      'Expanding the mini monitor at the screen edge must keep its controls inside the work area');
  }
  assert.equal(await mini.webContents.executeJavaScript(miniLayout), true, 'Expanded mini monitor must show both rates and all buttons');
  writeFileSync(join(output, 'network-mini.png'), miniCapture.toPNG());
  screenshots.push('network-mini.png');
  await mini.webContents.executeJavaScript(`document.querySelector('[aria-label="收起曲线"]').click()`);
  await wait(`!!document.querySelector('[aria-label="展开曲线"]') && !document.querySelector('.network-mini .network-chart')`, mini.webContents);
  writeFileSync(join(output, 'network-mini-compact.png'), (await mini.webContents.capturePage()).toPNG());
  screenshots.push('network-mini-compact.png');
  await mini.webContents.executeJavaScript(`document.querySelector('[aria-label="隐藏小窗"]').click()`);
  for (let attempt = 0; attempt < 40 && mini.isVisible(); attempt++) await delay(50);
  assert.equal(mini.isVisible(), false, 'Hiding the monitor must close its visible window');
  assert.equal((await network()).state, 'connected', 'Hiding the monitor must preserve the connection');
  await click(disconnectButton);
  await wait(networkState('idle'));
  assert.deepEqual(modelConfig(), before);
  assert.equal(store.getManagedState('network.flowbridge.lease', false), false);
  writeFileSync(join(output, 'network-validation.json'), JSON.stringify({ ok: true, defaultNetworkWorkspace: true,
    sidebarNetworkBeforeAuth: true, dedicatedNetworkPage: true, sessionPreservedAcrossNavigation: true,
    completedLatencyPreservedAcrossNavigation: true, pendingLatencyCompletesWhileHidden: true, latencyResetsOnModeAndAddressChange: true,
    offlineSpeedFromDraft: true, connectedWithDraft: true, explicitReconnect: true, cleanupRecovery: true, gatewayControlsIndependent: true, twelveWebsiteLatenciesOnly: true, trafficWindows: [1, 5, 15, 60], simulatedNetworkConnectDisconnectAndCancel: true,
    osNetworkUntouched: true, existingDataPreserved: true, anonymousElectronRedirectProbe: true,
    miniPreloadIsolated: true, layouts, screenshots }, null, 2));
  if (process.env.MODELDOCK_SMOKE_NETWORK_HOLD === '1') { window.show(); await delay(60_000); }
}
