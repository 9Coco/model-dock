import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { Store } from '../src/main/store';
import { bindingConnectionPolicy, resolveBindingModels } from '../src/shared/bindings';
import { directModelsForProvider, isSingleEntryTool, switchSingleEntryMode, updateSingleEntryBinding } from '../src/shared/single-entry';
import type { ToolBinding } from '../src/shared/types';

const stores: Store[] = [], folders: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-trae-binding-')); folders.push(dir);
  const store = await Store.create(dir); stores.push(store);
  const api = store.saveProvider({ name: 'Trae API fixture', kind: 'openai-compatible', baseUrl: 'https://trae-api.example.test/v1', enabled: true, apiKey: 'synthetic-only' });
  const subscription = store.saveProvider({ name: 'Trae subscription fixture', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
  const input = { providerId: api.id, upstreamId: 'chat-model', alias: 'trae-chat', displayName: 'Trae chat', wireApi: 'chat-completions' as const, contextWindow: 0, tools: true, vision: false, enabled: true };
  const chat = store.saveModel(input);
  const messages = store.saveModel({ ...input, upstreamId: 'messages-model', alias: 'trae-messages', wireApi: 'messages' });
  const responses = store.saveModel({ ...input, upstreamId: 'responses-model', alias: 'trae-responses', wireApi: 'responses' });
  const account = store.saveModel({ ...input, providerId: subscription.id, upstreamId: 'subscription-model', alias: 'trae-subscription', wireApi: 'responses' });
  const binding: ToolBinding = { id: 'trae', name: 'Trae CN', enabled: true, mode: 'direct', providerIds: [api.id], modelIds: [], defaultModelId: messages.id, note: '' };
  return { dir, store, api, subscription, chat, messages, responses, account, binding };
}

describe('Trae binding persistence and protocol boundaries', () => {
  it('adds a disabled Trae entry to existing stores without modifying other tools or client files', async () => {
    const f = await fixture();
    const sentinel = join(f.dir, 'settings.json'); writeFileSync(sentinel, '{"unrelated":"preserve"}');
    const before = f.store.listBindings().filter(binding => binding.id !== 'trae'); f.store.close();
    const SQL = await initSqlJs(), db = new SQL.Database(readFileSync(join(f.dir, 'modeldock.sqlite')));
    db.run("DELETE FROM bindings WHERE id='trae'"); writeFileSync(join(f.dir, 'modeldock.sqlite'), db.export()); db.close();
    const reopened = await Store.create(f.dir); stores.push(reopened);
    expect(reopened.listBindings().find(binding => binding.id === 'trae')).toMatchObject({ enabled: false, mode: 'direct', providerIds: [], modelIds: [] });
    expect(reopened.listBindings().filter(binding => binding.id !== 'trae')).toEqual(before);
    expect(readFileSync(sentinel, 'utf8')).toBe('{"unrelated":"preserve"}');
    expect(existsSync(join(f.dir, 'Trae CN'))).toBe(false);
  });

  it('allows all three native API protocols while rejecting direct subscriptions and multi-provider selections', async () => {
    const f = await fixture();
    expect(isSingleEntryTool('trae')).toBe(true);
    expect(directModelsForProvider('trae', f.api, f.store.listModels()).map(model => model.id)).toEqual([f.chat.id, f.messages.id, f.responses.id]);
    f.store.saveBinding(f.binding);
    const saved = f.store.listBindings().find(binding => binding.id === 'trae')!;
    expect(resolveBindingModels(saved, f.store.listModels(), f.store.listProviders()).map(model => model.id)).toEqual([f.chat.id, f.messages.id, f.responses.id]);
    expect(bindingConnectionPolicy(saved, f.store.listModels(), f.store.listProviders())).toMatchObject({ kind: 'direct', groups: [{ connection: 'direct-api', providerIds: [f.api.id] }] });
    for (const binding of [
      { ...f.binding, providerIds: [f.subscription.id], defaultModelId: f.account.id },
      { ...f.binding, providerIds: [f.api.id, f.subscription.id] },
      { ...f.binding, mode: 'auto' as const },
    ]) expect(() => f.store.saveBinding(binding)).toThrow();
    expect(f.store.listBindings().find(binding => binding.id === 'trae')).toEqual(saved);
  });

  it('keeps exact aggregate mappings across all supported upstream protocols and preserves an explicit empty mapping', async () => {
    const f = await fixture();
    const aggregate: ToolBinding = { ...f.binding, mode: 'aggregate', providerIds: [f.api.id, f.subscription.id], modelSelection: 'selected', modelIds: [f.messages.id, f.responses.id, f.account.id], defaultModelId: f.account.id };
    f.store.saveBinding(aggregate);
    expect(resolveBindingModels(aggregate, f.store.listModels(), f.store.listProviders()).map(model => model.id)).toEqual([f.messages.id, f.responses.id, f.account.id]);
    expect(bindingConnectionPolicy(aggregate, f.store.listModels(), f.store.listProviders())).toMatchObject({ kind: 'aggregate', groups: [{ connection: 'local-managed', modelIds: aggregate.modelIds }] });
    const cleared = { ...aggregate, modelIds: [], defaultModelId: '' }; f.store.saveBinding(cleared);
    f.store.close(); const reopened = await Store.create(f.dir); stores.push(reopened);
    const saved = reopened.listBindings().find(binding => binding.id === 'trae')!;
    expect(saved).toMatchObject({ modelSelection: 'selected', modelIds: [], defaultModelId: '' });
    expect(resolveBindingModels(saved, reopened.listModels(), reopened.listProviders())).toEqual([]);
  });

  it('restores separate direct and aggregate drafts after save and reopen without re-enabling unavailable direct sources', async () => {
    const f = await fixture(), models = f.store.listModels(), providers = f.store.listProviders();
    let binding = updateSingleEntryBinding(f.binding, {}, models, providers); f.store.saveBinding(binding);
    binding = switchSingleEntryMode(binding, 'aggregate', models, providers);
    binding = updateSingleEntryBinding(binding, { providerIds: [f.api.id, f.subscription.id], modelIds: [f.account.id], modelSelection: 'selected', defaultModelId: f.account.id, enabled: true }, models, providers);
    f.store.saveBinding(binding); f.store.close();
    const reopened = await Store.create(f.dir); stores.push(reopened);
    const saved = reopened.listBindings().find(binding => binding.id === 'trae')!;
    const direct = switchSingleEntryMode(saved, 'direct', reopened.listModels(), reopened.listProviders());
    expect(direct).toMatchObject({ providerIds: [f.api.id], defaultModelId: f.messages.id, enabled: true });
    const aggregate = switchSingleEntryMode(direct, 'aggregate', reopened.listModels(), reopened.listProviders());
    expect(aggregate).toMatchObject({ providerIds: [f.api.id, f.subscription.id], modelIds: [f.account.id], modelSelection: 'selected', defaultModelId: f.account.id });
    const unavailable = switchSingleEntryMode(saved, 'direct', reopened.listModels(), reopened.listProviders().map(provider => provider.id === f.api.id ? { ...provider, enabled: false } : provider));
    expect(unavailable).toMatchObject({ enabled: false, providerIds: [f.api.id], defaultModelId: f.messages.id });
    expect(bindingConnectionPolicy(unavailable, reopened.listModels(), reopened.listProviders()).groups).toEqual([]);
  });
});
