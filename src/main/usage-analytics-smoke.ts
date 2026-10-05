import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from './store';
import type { UsageQuery, UsageSnapshot } from '../shared/usage-types';
import { usageDateRange } from '../shared/usage-report';

export async function verifyUsageAnalytics(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child));
  const evaluate = async <T>(code: string): Promise<T> => {
    const result = await window.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await(${code})}}catch(error){return {ok:false,message:error instanceof Error?error.message:'UI script failed'}}})()`);
    if (!result.ok) throw new Error(`Usage UI: ${result.message}; expression: ${code.slice(0, 140)}`);
    return result.value as T;
  };
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(code: string, label: string) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(code)) return; await pause(35); }
    writeFileSync(join(outputDir, 'electron-usage-analytics-timeout.png'), await captureUi());
    const debug = await evaluate('({text:document.body.innerText.slice(-3500),tab:document.querySelector("[data-usage-view]")?.getAttribute("data-usage-view")})');
    writeFileSync(join(outputDir, 'usage-analytics-timeout.json'), JSON.stringify(debug, null, 2));
    throw new Error(`Usage analytics timed out: ${label}`);
  }
  async function click(selector: string) { await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  async function select(label: string, value: string) {
    await waitFor(`!!document.querySelector('select[aria-label="${label}"]')`, `${label} mounted`);
    await evaluate(`(()=>{const input=document.querySelector('select[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('select[aria-label="${label}"]')?.value===${JSON.stringify(value)}`, label);
  }
  const formatter = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = formatter.formatToParts(new Date()), part = (type: string) => parts.find(item => item.type === type)?.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`, bounds = usageDateRange(day, day);
  const query: UsageQuery = { ...bounds, source: 'client', timeZone: 'Asia/Hong_Kong', granularity: 'hour' };
  const start = Math.max(Date.parse(bounds.from) + 1000, Date.now() - 60_000);
  const home = join(store.dataDir, 'test-home'), sessionDirectory = join(home, '.codex', 'sessions', ...day.split('-'));
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionFile = join(sessionDirectory, 'rollout-usage-analytics.jsonl');
  const lines: unknown[] = [
    { timestamp: new Date(start).toISOString(), type: 'session_meta', payload: { id: 'usage-analytics-session' } },
    { timestamp: new Date(start).toISOString(), type: 'turn_context', payload: { model: 'gpt-demo-codex', turn_id: 'usage-turn' } },
    { timestamp: new Date(start).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: 'PRIVATE_USAGE_MESSAGE_MUST_NOT_BE_STORED' } },
  ];
  for (let index = 1; index <= 30; index++) lines.push({ timestamp: new Date(start + index * 100).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 100 * index, cached_input_tokens: 20 * index, output_tokens: 20 * index },
    last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 20 },
  } } });
  writeFileSync(sessionFile, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const openCodeDirectory = join(home, '.local', 'share', 'opencode'); mkdirSync(openCodeDirectory, { recursive: true });
  const openCodeFile = join(openCodeDirectory, 'opencode.db'), database = new DatabaseSync(openCodeFile);
  database.exec('CREATE TABLE session_v2(id TEXT PRIMARY KEY,time_created INTEGER,time_updated INTEGER); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT,type TEXT);');
  database.prepare('INSERT INTO session_v2 VALUES(?,?,?)').run('ses_usage', start, start + 5000);
  database.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)').run('msg_usage', 'ses_usage', start, start + 5000, JSON.stringify({ model: { id: 'gpt-demo-opencode', providerID: 'openai' }, time: { created: start, completed: start + 5000 }, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 60, write: 40 } }, text: 'PRIVATE_USAGE_MESSAGE_MUST_NOT_BE_STORED' }), 'assistant');
  database.close();
  const fingerprint = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const originals = [fingerprint(sessionFile), fingerprint(openCodeFile)];
  await click('[data-page="usage"]');
  await waitFor(`document.querySelector('[data-stat="requests"]')?.dataset.value==='31'`, 'first visible page synchronization');
  assert.equal(await evaluate<string>('document.querySelector("[aria-label=用量自动刷新]").value'), '30');
  await select('用量自动刷新', '0');
  const initial = await evaluate<UsageSnapshot>(`window.modelDock.usageQuery(${JSON.stringify(query)})`);
  assert.equal(initial.requests, 31); assert.equal(initial.totalTokens, 3825); assert.equal(initial.newInputTokens, 2500);
  assert.equal(initial.cachedInputTokens, 660); assert.equal(initial.cacheCreationInputTokens, 40); assert.equal(initial.outputTokens, 625);
  assert.equal(initial.estimatedCostUsd, null); assert.equal(initial.hourly.length, 24); assert.equal(initial.logs.length, 25); assert.equal(initial.pagination.totalPages, 2);
  assert.ok(initial.logs.every(row => row.status === null && row.durationMs === null && row.tokensPerSecond === null));
  for (const model of initial.filters.models) await evaluate(`window.modelDock.usageSavePrice(${JSON.stringify({ modelId: model.key, inputUsdPerMillion: 10, cachedInputUsdPerMillion: 2, cacheCreationUsdPerMillion: 6, outputUsdPerMillion: 20 })})`);
  await click('[data-action="usage-sync-now"]');
  await waitFor(`document.querySelector('[data-stat="cost"]')?.dataset.value!=='null'&&!document.querySelector('[data-action="usage-sync-now"]').disabled`, 'historical pricing and repeat synchronization');
  const priced = await evaluate<UsageSnapshot>(`window.modelDock.usageQuery(${JSON.stringify(query)})`);
  assert.equal(priced.requests, 31); assert.ok(Math.abs(priced.estimatedCostUsd! - 0.03906) < 1e-10);
  assert.equal(priced.costedRequests, 31); assert.equal(priced.cacheHitPercent, 20.625);
  await click('[data-action="usage-page-next"]'); await waitFor('document.querySelectorAll("[data-usage-log-row]").length===11', 'second logs page');
  await click('[data-action="usage-page-previous"]'); await waitFor('document.querySelectorAll("[data-usage-log-row]").length===20', 'first logs page');
  await click('[data-usage-tool="codex"]'); await waitFor('document.querySelector("[data-stat=requests]")?.dataset.value==="30"', 'tool chip filter');
  await click('[data-usage-tool="all"]'); await waitFor('document.querySelector("[data-stat=requests]")?.dataset.value==="31"', 'all tool chip');
  await click('[data-action="usage-tab-provider"]'); await waitFor('!!document.querySelector("[data-usage-group-key]")', 'provider statistics');
  await click('[data-action="usage-tab-models"]'); await click('[data-action="usage-tab-pricing"]');
  assert.ok(await evaluate<boolean>('!!document.querySelector("[data-usage-price-model]")'));
  await click('[data-action="usage-data-sources"]'); await waitFor('document.querySelectorAll("[data-usage-data-source]").length===6', 'data sources and known unsupported clients');
  const sourceText = await evaluate<string>('document.querySelector("[role=dialog]").textContent'); assert.match(sourceText, /Codex/); assert.match(sourceText, /OpenCode/); assert.match(sourceText, /暂不支持/); assert.match(sourceText, /不保存/);
  await click('[aria-label="关闭对话框"]'); await click('[data-action="usage-tab-logs"]');
  assert.deepEqual([fingerprint(sessionFile), fingerprint(openCodeFile)], originals, 'Native log imports must not write client files');
  assert.equal(readFileSync(join(store.dataDir, 'modeldock.sqlite')).includes(Buffer.from('PRIVATE_USAGE_MESSAGE_MUST_NOT_BE_STORED')), false);
  const layouts: unknown[] = [];
  for (const theme of ['light', 'dark']) {
    await click('[data-page="settings"]'); await click(`[data-theme-choice="${theme}"]`); await click('[data-page="usage"]'); await select('用量自动刷新', '0');
    await waitFor('document.querySelector("[data-stat=requests]")?.dataset.value==="31"', 'pricing and query survive navigation');
    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await pause(180);
      const layout = await evaluate<{ horizontalOverflow: boolean; logs: number; chart: boolean }>('({horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,logs:document.querySelectorAll("[data-usage-log-row]").length,chart:!!document.querySelector(".usage-trend-plot svg")})');
      assert.equal(layout.horizontalOverflow, false); assert.equal(layout.logs, 20); assert.equal(layout.chart, true);
      layouts.push({ theme, width, ...layout }); writeFileSync(join(outputDir, `electron-usage-analytics-${theme}-${width}.png`), await captureUi());
    }
  }
  const provider = store.saveProvider({ name: 'Usage gateway fixture', kind: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', enabled: true });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'gateway-demo', alias: 'gateway-demo', displayName: 'Gateway demo', wireApi: 'responses', contextWindow: 0, tools: false, vision: false, enabled: true });
  for (const [index, status] of [200, 429].entries()) store.addLog({ id: `usage-gateway-${index}`, time: new Date(start + index * 100).toISOString(), alias: model.alias, providerName: provider.name, providerId: provider.id, modelId: model.id, tool: 'codex', endpoint: '/responses', status, durationMs: 1000, usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 20 } });
  const failed = await evaluate<UsageSnapshot>(`window.modelDock.usageQuery(${JSON.stringify({ ...query, source: 'gateway', status: 429 })})`);
  assert.equal(failed.requests, 1); assert.equal(failed.logs[0].status, 429); assert.equal(failed.logs[0].tokensPerSecond, 20);
  assert.equal((await evaluate<UsageSnapshot>(`window.modelDock.usageQuery(${JSON.stringify(query)})`)).requests, 31, 'Gateway calls must not double-count client events');
  const text = await evaluate<string>('document.body.innerText'); assert.doesNotMatch(text, /PRIVATE_USAGE_MESSAGE_MUST_NOT_BE_STORED/);
  writeFileSync(join(outputDir, 'usage-analytics-validation.json'), JSON.stringify({ ok: true, clientEvents: 31, tokenTotal: 3825, newInput: 2500, cacheRead: 660, cacheWrite: 40, cacheHitPercent: 20.625, estimatedCostUsd: priced.estimatedCostUsd, automaticVisiblePageSync: true, repeatSyncIdempotent: true, readonlyClientFiles: true, rawMessagesNotStored: true, nativeStatusAndSpeedUnknown: true, exactGatewayStatusAndMeasuredSpeed: true, hourlyToday: true, paginatedLogs: true, toolFilters: true, historicalPricing: true, dataSources: 6, unsupportedClientsExplicit: true, layouts, realClientProfilesChanged: false, realSessionsRead: false }, null, 2));
}
