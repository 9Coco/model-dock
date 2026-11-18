import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { Store } from '../src/main/store';
import { buildConfig } from '../src/main/adapters';
import { providerPresets } from '../src/shared/presets';
import type { ModelInput } from '../src/shared/types';

const directories: string[] = [], stores: Store[] = [];
const codec = { encrypt: (value: string) => `test:${Buffer.from(value).toString('base64')}`, decrypt: (value: string) => Buffer.from(value.slice(5), 'base64').toString() };
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const modelInput = (providerId: string, alias: string): ModelInput => ({ providerId, alias, upstreamId: alias, displayName: alias, wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });

it('retires legacy subscriptions and all binding drafts while preserving data, other sources and JetBrains tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-retired-subscription-')); directories.push(directory);
  let store = await Store.create(directory, codec); stores.push(store);
  const initialProviders = store.listProviders().map(provider => provider.id);
  // Create the prior-version database shape, then stamp its historical preset.
  const retired = store.saveProvider({ name: 'Legacy account', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:18081/v1', enabled: true, apiKey: 'synthetic-retired-key' });
  const keeper = store.saveProvider({ name: 'JetBrains custom API', kind: 'openai-compatible', baseUrl: 'https://api.example.test/v1', enabled: true, apiKey: 'synthetic-api-key' });
  const oldModel = store.saveModel(modelInput(retired.id, 'archived-model')), keptModel = store.saveModel(modelInput(keeper.id, 'kept-model'));
  store.setManagedState(`auth-metadata:${retired.id}`, { nativeIde: { encryptedSnapshot: 'synthetic' } });
  store.setManagedState(`auth-usage:${retired.id}`, { status: 'ready', windows: [] });
  store.setJetBrainsPlugin('rider', 'air');
  const binding = (tool: string) => store.listBindings().find(item => item.id === tool)!;
  for (const tool of ['opencode', 'rider'] as const) store.saveBinding({ ...binding(tool), enabled: true, mode: 'aggregate', providerIds: [retired.id, keeper.id], modelIds: [oldModel.id, keptModel.id], modelSelection: 'selected', defaultModelId: oldModel.id });
  store.saveBinding({ ...binding('vscode'), enabled: true, mode: 'aggregate', providerIds: [retired.id], modelIds: [oldModel.id], modelSelection: 'selected', defaultModelId: oldModel.id });
  store.saveBinding({ ...binding('webstorm'), enabled: true, mode: 'direct', providerIds: [keeper.id], modelIds: [], modelSelection: 'all', defaultModelId: keptModel.id,
    connectionChoices: { aggregate: { providerIds: [retired.id], modelIds: [oldModel.id], modelSelection: 'selected', defaultModelId: oldModel.id, completionModelId: oldModel.id } } });
  store.saveBinding({ ...binding('pycharm'), enabled: true, mode: 'direct', providerIds: [keeper.id], modelIds: [], modelSelection: 'all', defaultModelId: keptModel.id });
  const untouched = binding('pycharm'), directBefore = buildConfig(store, 'webstorm', 18181).content;
  store.close();
  const SQL = await initSqlJs(), filename = join(directory, 'modeldock.sqlite'), legacy = new SQL.Database(readFileSync(filename));
  legacy.run('UPDATE providers SET preset_id=? WHERE id=?', ['jetbrains-central', retired.id]);
  const archiveSql = `SELECT * FROM providers WHERE id='${retired.id}'; SELECT * FROM models WHERE provider_id='${retired.id}'; SELECT * FROM secrets WHERE provider_id='${retired.id}'; SELECT * FROM settings WHERE key IN ('managed:auth-metadata:${retired.id}','managed:auth-usage:${retired.id}');`;
  const originalRows = legacy.exec(archiveSql);
  writeFileSync(filename, legacy.export()); legacy.close();

  store = await Store.create(directory, codec); stores.push(store);
  expect(providerPresets.some(preset => preset.id === 'jetbrains-central')).toBe(false);
  expect(store.listProviders().map(provider => provider.id)).toEqual([...initialProviders, keeper.id]);
  expect(store.getProvider(retired.id)).toBeUndefined();
  expect(store.getSecret(retired.id)).toBeUndefined();
  expect(store.listModels().map(model => model.id)).toEqual([keptModel.id]);
  expect(store.getSecret(keeper.id)?.apiKey).toBe('synthetic-api-key');
  for (const tool of ['opencode', 'rider']) expect(binding(tool)).toMatchObject({ enabled: true, providerIds: [keeper.id], modelIds: [keptModel.id], defaultModelId: '' });
  expect(binding('vscode')).toMatchObject({ enabled: false, providerIds: [], modelIds: [], defaultModelId: '' });
  expect(binding('webstorm').connectionChoices?.aggregate).toEqual({ providerIds: [], modelIds: [], modelSelection: 'selected', defaultModelId: '' });
  expect(buildConfig(store, 'webstorm', 18181).content).toBe(directBefore);
  expect(binding('pycharm')).toEqual(untouched);
  expect(store.getJetBrainsPlugin('rider')).toBe('air');
  expect(store.listBindings().map(item => item.id)).toEqual(expect.arrayContaining(['webstorm', 'intellij-idea', 'rider', 'pycharm', 'junie']));
  expect(store.getManagedState<unknown[]>('retired-jetbrains-subscriptions:bindings', [])).toHaveLength(4);

  expect(() => store.saveProvider({ ...retired, presetId: 'jetbrains-central' })).toThrow();
  expect(() => store.saveProvider({ name: 'New account', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: retired.baseUrl, enabled: true })).toThrow(/预设/);
  expect(() => store.setSecret(retired.id, { apiKey: 'replacement' })).toThrow();
  expect(() => store.saveModel(modelInput(retired.id, 'cannot-route'))).toThrow();
  expect(() => store.saveModel({ ...modelInput(keeper.id, 'cannot-overwrite'), id: oldModel.id })).toThrow(/停用/);
  expect(() => store.deleteModel(oldModel.id)).toThrow(/停用/);
  await expect(store.saveRelayClientImport({ ...retired, presetId: 'jetbrains-central' }, {})).rejects.toThrow(/导入来源/);
  // A retired model must not prevent a supported API from adding that model name.
  const added = store.saveModel(modelInput(keeper.id, oldModel.alias));
  expect(added.alias).not.toBe(oldModel.alias);
  const selections = store.listBindings(); store.close();
  const raw = new SQL.Database(readFileSync(filename));
  try { expect(raw.exec(archiveSql)).toEqual(originalRows); }
  finally { raw.close(); }
  store = await Store.create(directory, codec); stores.push(store);
  expect(store.listBindings()).toEqual(selections);
});
