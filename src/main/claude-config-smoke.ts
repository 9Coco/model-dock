import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';

/** 修改点：只在专用 smoke 构建中操作临时 Claude 配置，不启动真实 Claude 或调用供应商。 */
export async function verifyClaudeConfiguration(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  assert.equal(resolve(store.dataDir), resolve(process.env.MODELDOCK_DATA_DIR!));
  assert.ok(!relative(join(outputDir, 'data'), store.dataDir).startsWith('..'));
  const upstream = new URL(process.env.MODELDOCK_SMOKE_UPSTREAM!);
  assert.equal(upstream.hostname, '127.0.0.1'); assert.equal(upstream.protocol, 'http:');
  upstream.pathname = '/claude';
  const target = join(store.dataDir, 'feature-home', '.claude', 'settings.json');
  const preserved = { permissions: { defaultMode: 'default' }, hooks: { SessionStart: [] }, env: { USER_SENTINEL: 'keep', ANTHROPIC_API_KEY: 'synthetic-original-only' } };
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, JSON.stringify(preserved), { mode: 0o600 });
  const provider = store.saveProvider({ name: 'Claude 模拟中转', kind: 'openai-compatible', presetId: 'anthropic', messagesAuth: 'bearer', baseUrl: upstream.href, enabled: true, apiKey: 'synthetic-only' });
  const first = store.saveModel({ providerId: provider.id, upstreamId: 'mock-claude', alias: 'claude-local-alias', displayName: '验证 Messages 模型', wireApi: 'messages', contextWindow: 200000, tools: true, vision: true, enabled: true });
  const second = store.saveModel({ ...first, id: undefined, upstreamId: 'mock-claude-fast', alias: 'claude-fast-alias' });
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(30); }
    writeFileSync(join(outputDir, 'claude-ui-timeout.png'), await captureUi());
    throw new Error('Claude Code UI 验证等待超时');
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  const config = () => JSON.parse(readFileSync(target, 'utf8'));
  await click('[aria-label="刷新本机配置"]');
  await click('[data-page="tools"][data-tool-id="claude-code"]');
  await waitFor(`!!document.querySelector('[data-tool-binding="claude-code"]')`);
  assert.equal(await evaluate<boolean>(`document.querySelector('[data-action="claude-disable-telemetry"]').checked`), true);
  assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-action="select-all-tool-providers"]')`), false);
  await waitFor(`!!document.querySelector('[data-action="single-entry-direct-provider"]')&&!document.querySelector('[data-action="single-entry-direct-provider"]').disabled`);
  await evaluate(`(()=>{const select=document.querySelector('[data-action="single-entry-direct-provider"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(provider.id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced'&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled`);
  assert.equal(config().env.ANTHROPIC_MODEL, first.upstreamId);
  assert.equal(config().env.ANTHROPIC_BASE_URL, upstream.href.replace(/\/$/, ''));
  assert.equal(config().env.ANTHROPIC_AUTH_TOKEN, 'synthetic-only');
  assert.equal(config().env.ANTHROPIC_API_KEY, undefined);
  assert.equal(config().env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.deepEqual(config().availableModels, [first.upstreamId, second.upstreamId]);
  assert.deepEqual(config().modelPicker.options.map((item: { model: string }) => item.model), [first.upstreamId, second.upstreamId]);
  assert.equal(config().modelPicker.replaceBuiltInOptions, true);
  assert.equal(await evaluate<boolean>(`document.querySelector('[data-claude-vscode-refresh]')?.textContent.includes('Developer: Restart Local Agent Host')`), true);
  assert.deepEqual(config().permissions, preserved.permissions); assert.deepEqual(config().hooks, preserved.hooks);
  assert.equal(config().env.USER_SENTINEL, 'keep');
  assert.ok(readdirSync(join(store.dataDir, 'backups')).some(name => name.startsWith('claude-code-')));
  const inference = await evaluate<any>(`window.modelDock.testProvider(${JSON.stringify(provider.id)},{modelId:${JSON.stringify(first.id)}})`);
  assert.equal(inference.ok, true); assert.equal(inference.wireApi, 'messages');
  await evaluate(`(()=>{const select=document.querySelector('[data-action="tool-default-model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(second.id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='claude-code');return binding.defaultModelId===${JSON.stringify(second.id)}&&document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced'&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled;})()`);
  assert.equal(config().env.ANTHROPIC_MODEL, second.upstreamId);
  await click('[data-action="claude-disable-telemetry"]');
  await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='claude-code');return binding.claudeDisableTelemetry===false&&document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced'&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled;})()`);
  assert.equal(Object.hasOwn(config().env, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'), false);
  await click('[data-action="claude-disable-telemetry"]');
  await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='claude-code');return binding.claudeDisableTelemetry===true&&document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced'&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled;})()`);
  assert.equal(config().env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  const layouts = [];
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1320, 880], [980, 680]]) {
    window.setSize(width, height);
    await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('.main-content').scrollTop=0;})()`);
    await pause(120);
    const layout = await evaluate<any>(`(()=>{const main=document.querySelector('.main-content'),privacy=document.querySelector('[data-action="claude-disable-telemetry"]').getBoundingClientRect();return {horizontalOverflow:main.scrollWidth>main.clientWidth+1,privacyInViewport:privacy.left>=0&&privacy.right<=innerWidth+1&&privacy.top>=0&&privacy.bottom<=innerHeight+1};})()`);
    assert.equal(layout.horizontalOverflow, false); assert.equal(layout.privacyInViewport, true);
    layouts.push({ theme, width, height, ...layout });
    writeFileSync(join(outputDir, `claude-${theme}-${width}.png`), await captureUi());
  }
  await click('[data-action="preview-tool-config"]');
  await waitFor(`!!document.querySelector('.config-code')`);
  assert.equal((await evaluate<string>('document.querySelector(".config-code").textContent')).includes('synthetic-only'), false);
  writeFileSync(join(outputDir, 'claude-preview.png'), await captureUi());
  await click('[aria-label="关闭对话框"]');
  // 修改点：订阅使用临时本机端口和本机 key，不发真实账号推理请求。
  const subscription = store.saveProvider({ name: 'Claude 订阅验证', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
  store.setSecret(subscription.id, { accessToken: 'SYNTHETIC_SUB_OAUTH', refreshToken: 'SYNTHETIC_SUB_REFRESH', expiresAt: Date.now() + 3600000 });
  const subscriptionModel = store.saveModel({ providerId: subscription.id, upstreamId: 'subscription-upstream-id', alias: 'subscription-local-alias', displayName: '订阅模型', wireApi: 'responses', contextWindow: 0, tools: true, vision: false, enabled: true });
  const gateway = await evaluate<any>('window.modelDock.startGateway(0)');
  assert.equal(gateway.running, true);
  await click('[aria-label="刷新本机配置"]');
  await click('[data-action="tool-use-aggregate"]');
  await waitFor(`!!document.querySelector('[data-aggregate-internal="claude-code"]')&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled`);
  if (await evaluate<boolean>(`document.querySelector('article[data-provider-id="${provider.id}"] input[data-action="select-tool-provider"]')?.checked===true`)) await click(`article[data-provider-id="${provider.id}"] input[data-action="select-tool-provider"]`);
  await click(`article[data-provider-id="${subscription.id}"] input[data-action="select-tool-provider"]`);
  await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='claude-code');return binding.providerIds.length===1&&binding.providerIds[0]===${JSON.stringify(subscription.id)}&&document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced'&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled;})()`);
  assert.equal(config().env.ANTHROPIC_MODEL, subscriptionModel.alias);
  assert.equal(config().env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${gateway.port}/tool/claude-code`);
  assert.equal(config().env.CLAUDE_CODE_DISABLE_THINKING, '1');
  assert.equal(JSON.stringify(config()).includes('SYNTHETIC_SUB_OAUTH'), false);
  assert.equal(JSON.stringify(config()).includes('SYNTHETIC_SUB_REFRESH'), false);
  assert.equal(await evaluate<string>('document.querySelector("[data-claude-connection-kind]").dataset.claudeConnectionKind'), 'local-managed');
  writeFileSync(join(outputDir, 'claude-subscription.png'), await captureUi());
  await click('[data-action="restore-official-tool-config"]');
  await click('[data-action="confirm-tool-restore"]');
  await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='claude-code');return !binding.enabled&&document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='official'&&!document.querySelector('[data-action="restore-official-tool-config"]')?.disabled;})()`);
  assert.equal(config().env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(config().env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(config().env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.deepEqual(config().permissions, preserved.permissions); assert.deepEqual(config().hooks, preserved.hooks);
  assert.equal(existsSync(join(store.dataDir, 'feature-home', '.claude.json')), false);
  writeFileSync(join(outputDir, 'claude-ui-validation.json'), JSON.stringify({ ok: true, layouts, defaultUsesUpstreamId: true, previewRedacted: true, backupCreated: true, privacyToggleUnsetInsteadOfZero: true, unrelatedSettingsPreserved: true, restoreRetainsPrivacy: true, mockMessagesInference: inference.ok, subscriptionLocalKeyOnly: true, subscriptionDefaultUsesAlias: true }, null, 2));
}
