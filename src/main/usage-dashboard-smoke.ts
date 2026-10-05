import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import type { Model, Provider, ToolId } from '../shared/types';
import type { UsageQuery, UsageSnapshot } from '../shared/usage-types';
import { usageDateRange } from '../shared/usage-report';
import { usageRange } from '../shared/usage-display';

/** Uses only synthetic records in the smoke runner's isolated database. */
export async function verifyUsageDashboard(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE;
  const smokeDataDir = process.env.MODELDOCK_DATA_DIR;
  assert.ok(smokeDir && smokeDataDir, 'Usage dashboard smoke requires explicit isolation');
  assert.equal(resolve(outputDir), resolve(smokeDir));
  assert.equal(resolve(store.dataDir), resolve(smokeDataDir));
  const withinFixtures = relative(resolve(smokeDir, 'data'), resolve(store.dataDir));
  assert.ok(withinFixtures && !withinFixtures.startsWith('..') && !/^[A-Za-z]:/.test(withinFixtures), 'Usage smoke database must be below its fixture directory');
  const upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
  assert.ok(upstream && new URL(upstream).protocol === 'http:' && new URL(upstream).hostname === '127.0.0.1', 'Usage smoke requires a loopback fixture upstream');

  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(source)) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Usage dashboard smoke timed out: ${label}`);
  }
  const selector = (value: string) => JSON.stringify(value);
  async function click(value: string): Promise<void> {
    await waitFor(`!!document.querySelector(${selector(value)})`, value);
    await evaluate(`(()=>{const button=document.querySelector(${selector(value)});if(button.disabled)throw new Error('Usage control disabled: '+${selector(value)});button.click()})()`);
  }
  async function select(value: string, selected: string): Promise<void> {
    await waitFor(`Array.from(document.querySelector(${selector(value)})?.options??[]).some(option=>option.value===${JSON.stringify(selected)})`, `available filter ${selected}`);
    await evaluate(`(()=>{const input=document.querySelector(${selector(value)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,${JSON.stringify(selected)});input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await waitFor(`document.querySelector(${selector(value)})?.value===${JSON.stringify(selected)}`, 'filter value settled');
  }
  async function query(value: UsageQuery): Promise<UsageSnapshot> {
    return evaluate<UsageSnapshot>(`window.modelDock.usageQuery(${JSON.stringify(value)})`);
  }
  async function groups(dimension: 'provider' | 'tool' | 'model'): Promise<void> {
    // Group details now live below the trend, and drilling into a row opens
    // the request/event log tab. Reopen the desired statistics tab explicitly.
    await click(`[data-action="usage-tab-${dimension === 'model' ? 'models' : 'provider'}"]`);
    await click(`[data-action="usage-view-${dimension}"]`);
    await waitFor(`document.querySelector('.usage-panel')?.dataset.usageView==='${dimension === 'provider' ? 'byProvider' : dimension === 'tool' ? 'byTool' : 'byModel'}'`, `${dimension} statistics selected`);
  }
  async function clearFilters(): Promise<void> {
    await evaluate(`document.querySelector('[data-action="usage-clear-filters"]')?.click()`);
    await waitFor(`['用量工具筛选','用量供应商筛选','用量模型筛选'].every(label=>document.querySelector('[aria-label="'+label+'"]')?.value==='')`, 'dimension filters cleared');
  }
  async function metrics(requests: number, tokens: number): Promise<{ requests: number; tokens: number; cost: string | null }> {
    await waitFor(`document.querySelector('[data-stat="requests"]')?.dataset.value==='${requests}'&&document.querySelector('[data-stat="tokens"]')?.dataset.value==='${tokens}'`, `metrics ${requests}/${tokens}`);
    return evaluate(`(()=>({requests:Number(document.querySelector('[data-stat="requests"]').dataset.value),tokens:Number(document.querySelector('[data-stat="tokens"]').dataset.value),cost:document.querySelector('[data-stat="cost"]')?.dataset.value??null}))()`);
  }

  const providers: Provider[] = [];
  const models: Model[] = [];
  for (const suffix of ['A', 'B']) {
    const provider = store.saveProvider({ name: `用量统计套餐 ${suffix}`, kind: 'openai-compatible', presetId: 'custom', baseUrl: upstream, enabled: true, apiKey: 'synthetic-only' });
    const model = store.saveModel({ providerId: provider.id, upstreamId: `mock-usage-${suffix.toLowerCase()}`, alias: `usage-${suffix.toLowerCase()}`, displayName: `统计模型 ${suffix}`, wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
    providers.push(provider); models.push(model);
  }
  const time = new Date().toISOString();
  function log(index: number, tool: ToolId | undefined, input: number | undefined, cache: number, output: number, status: number, durationMs: number): void {
    store.addLog({ id: `usage-smoke-${randomUUID()}`, time, alias: models[index].alias, providerName: providers[index].name, providerId: providers[index].id, modelId: models[index].id, tool, endpoint: '/chat/completions', status, durationMs, ...(input === undefined ? {} : { usage: { inputTokens: input, cachedInputTokens: cache, outputTokens: output } }) });
  }
  log(0, 'codex', 100, 40, 20, 200, 100);
  log(0, 'dsh', 50, 0, 10, 200, 150);
  log(0, undefined, undefined, 0, 0, 429, 200);
  log(1, 'codex', 200, 100, 40, 200, 300);
  log(1, 'vscode', 0, 0, 0, 200, 50);
  log(1, 'copilot', undefined, 0, 0, 500, 250);
  await evaluate(`window.modelDock.usageSavePrice(${JSON.stringify({ modelId: models[0].id, inputUsdPerMillion: 10, cachedInputUsdPerMillion: 2, outputUsdPerMillion: 20 })})`);
  const calendar = usageRange(7);
  const range: UsageQuery = { ...usageDateRange(calendar.from, calendar.to), source: 'gateway', timeZone: 'Asia/Hong_Kong' };
  const providerA = await query({ ...range, providerId: providers[0].id });
  assert.equal(providerA.requests, 3); assert.equal(providerA.inputTokens, 150); assert.equal(providerA.outputTokens, 30); assert.equal(providerA.cachedInputTokens, 40); assert.equal(providerA.reportedRequests, 2);
  assert.ok(Math.abs((providerA.estimatedCostUsd ?? NaN) - 0.00178) < 1e-9);
  assert.equal(providerA.collection.missingUsageRecords, 1); assert.equal(providerA.collection.unscopedRecords, 1);
  assert.ok(providerA.byTool.some(row => row.key === 'unscoped' && row.requests === 1));
  assert.equal(providerA.daily.length, 7); assert.equal(providerA.daily.reduce((sum, row) => sum + row.requests, 0), 3); assert.equal(providerA.daily.filter(row => row.requests === 0).length, 6);
  const codexA = await query({ ...range, providerId: providers[0].id, tool: 'codex' });
  assert.equal(codexA.requests, 1); assert.equal(codexA.inputTokens + codexA.outputTokens, 120); assert.ok(Math.abs((codexA.estimatedCostUsd ?? NaN) - 0.00108) < 1e-9);
  const codexB = await query({ ...range, providerId: providers[1].id, tool: 'codex' });
  assert.equal(codexB.requests, 1); assert.equal(codexB.inputTokens, 200); assert.equal(codexB.outputTokens, 40); assert.equal(codexB.estimatedCostUsd, null);
  const unscopedA = await query({ ...range, providerId: providers[0].id, tool: 'unscoped' });
  assert.equal(unscopedA.requests, 1); assert.equal(unscopedA.reportedRequests, 0);
  const zeroB = await query({ ...range, providerId: providers[1].id, tool: 'vscode' });
  assert.equal(zeroB.requests, 1); assert.equal(zeroB.reportedRequests, 1); assert.equal(zeroB.inputTokens + zeroB.outputTokens, 0);

  await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click());document.querySelector('[aria-label="刷新本机配置"]').click()`);
  await waitFor(`!!document.querySelector('[data-source-id="${providers[1].id}"]')`, 'fixture suppliers refreshed');
  await click('[data-page="usage"]');
  await waitFor(`!!document.querySelector('[data-action="usage-tab-provider"]')&&!document.querySelector('.usage-panel')?.getAttribute('aria-busy')?.includes('true')`, 'usage dashboard mounted and initial client synchronization complete');
  await select('[aria-label="用量自动刷新"]', '0');
  await click('[data-action="usage-source-gateway"]');
  await select('[aria-label="用量时间范围"]', '7');
  await clearFilters();
  await groups('provider');
  await click(`tr[data-usage-group-key="${providers[0].id}"] [data-action="usage-drill-row"]`);
  await waitFor(`document.querySelector('[aria-label="用量供应商筛选"]')?.value==='${providers[0].id}'`, 'provider row applied filter');
  const providerUi = await metrics(3, 180);
  assert.ok(Math.abs(Number(providerUi.cost) - 0.00178) < 1e-9);
  await groups('tool');
  await waitFor(`document.querySelectorAll('tr[data-usage-group-key]').length===3`, 'provider A tool groups');
  const providerTools = await evaluate<string[]>(`Array.from(document.querySelectorAll('tr[data-usage-group-key]')).map(row=>row.dataset.usageGroupKey)`);
  assert.deepEqual([...providerTools].sort(), ['codex', 'dsh', 'unscoped']);
  await click('tr[data-usage-group-key="codex"] [data-action="usage-drill-row"]');
  await waitFor(`document.querySelector('[aria-label="用量工具筛选"]')?.value==='codex'`, 'tool row applied filter');
  const codexAUi = await metrics(1, 120);
  assert.ok(Math.abs(Number(codexAUi.cost) - 0.00108) < 1e-9);
  await select('[aria-label="用量供应商筛选"]', providers[1].id);
  const codexBUi = await metrics(1, 240);
  assert.ok(codexBUi.cost === '' || codexBUi.cost === 'null' || codexBUi.cost === null, 'Unpriced model cost must remain unknown');
  await select('[aria-label="用量模型筛选"]', models[1].id);
  await metrics(1, 240);
  await groups('model');
  await waitFor(`document.querySelectorAll('tr[data-usage-group-key]').length===1&&!!document.querySelector('tr[data-usage-group-key="${models[1].id}"]')`, 'model intersection applied');

  await clearFilters();
  await click('[data-action="usage-source-client"]');
  const client = await query({ ...range, source: 'client' });
  assert.equal(client.collection.unit, 'usage-event'); assert.equal(client.collection.requestMetricsAvailable, false);
  const clientUi = await metrics(client.requests, client.inputTokens + client.outputTokens);
  const clientMetrics = await evaluate<{ hasRequestMetrics: boolean; label: string }>(`(()=>({hasRequestMetrics:!!document.querySelector('[data-stat="success-rate"], [data-stat="latency"]')||Array.from(document.querySelectorAll('.usage-group-table th')).some(cell=>/成功率|时延/.test(cell.textContent)),label:document.querySelector('[data-stat="requests"]')?.closest('div')?.textContent??''}))()`);
  assert.equal(clientMetrics.hasRequestMetrics, false, 'Client counters cannot establish HTTP success or latency');
  assert.ok(clientMetrics.label.includes('事件'), 'Client records must be labelled as counter events');

  await click('[data-action="usage-source-gateway"]');
  await groups('provider');
  await select('[aria-label="用量供应商筛选"]', providers[0].id);
  await metrics(3, 180);
  const days = await evaluate<{ date: string; requests: number }[]>(`Array.from(document.querySelectorAll('[data-day][data-day-requests]')).map(element=>({date:element.dataset.day,requests:Number(element.dataset.dayRequests)}))`);
  assert.equal(days.length, 7); assert.equal(days.reduce((sum, row) => sum + row.requests, 0), 3); assert.equal(days.filter(row => row.requests === 0).length, 6);
  assert.deepEqual(days.map(row => row.date), providerA.daily.map(row => row.key));

  window.setSize(1320, 880);
  await waitFor(`innerWidth>1100`, 'large usage viewport');
  async function themeAndRestore(theme: 'light' | 'dark'): Promise<void> {
    await click('[data-page="settings"]');
    await click(`[data-theme-choice="${theme}"]`);
    await waitFor(`document.documentElement.dataset.theme==='${theme}'`, `${theme} usage theme`);
    await click('[data-page="usage"]');
    await waitFor(`!!document.querySelector('[data-action="usage-tab-provider"]')&&!document.querySelector('.usage-panel')?.getAttribute('aria-busy')?.includes('true')`, 'usage page synchronization completed after theme change');
    await select('[aria-label="用量自动刷新"]', '0');
    await click('[data-action="usage-source-gateway"]');
    await select('[aria-label="用量时间范围"]', '7');
    await clearFilters();
    await groups('provider');
    await select('[aria-label="用量供应商筛选"]', providers[0].id);
    await metrics(3, 180);
  }
  await themeAndRestore('light');
  writeFileSync(join(outputDir, 'electron-usage-dashboard-provider-light-1320.png'), await captureUi());
  await themeAndRestore('dark');
  writeFileSync(join(outputDir, 'electron-usage-dashboard-provider-1320.png'), await captureUi());
  await groups('tool');
  await waitFor(`document.querySelectorAll('tr[data-usage-group-key]').length===3`, 'tool groups for capture');
  writeFileSync(join(outputDir, 'electron-usage-dashboard-tool-1320.png'), await captureUi());
  window.setSize(980, 680);
  await waitFor(`innerWidth<1100`, 'compact usage viewport');
  const layout = await evaluate<{ overflow: boolean; footerVisible: boolean; controlsInside: boolean }>(`(()=>{
    const main=document.querySelector('main'),footer=document.querySelector('.sidebar-bottom'),rect=footer.getBoundingClientRect();
    const controls=Array.from(document.querySelectorAll('.usage-filters select:not(.sr-only),.usage-tool-selector button,.usage-sync-actions select'));
    return {overflow:main.scrollWidth>main.clientWidth+1,footerVisible:rect.bottom<=innerHeight+1&&rect.top>=0,controlsInside:controls.every(element=>{const bounds=element.getBoundingClientRect();return bounds.left>=0&&bounds.right<=innerWidth+1})};
  })()`);
  assert.equal(layout.overflow, false); assert.equal(layout.footerVisible, true); assert.equal(layout.controlsInside, true);
  writeFileSync(join(outputDir, 'electron-usage-dashboard-980.png'), await captureUi());
  writeFileSync(join(outputDir, 'usage-dashboard-validation.json'), JSON.stringify({ providers: providers.map(item => ({ id: item.id, name: item.name })), models: models.map(item => ({ id: item.id, alias: item.alias })), providerA, codexA, codexB, unscopedA, zeroB, providerUi, providerTools, codexAUi, codexBUi, client, clientUi, clientMetrics, days, layout }, null, 2));
}
